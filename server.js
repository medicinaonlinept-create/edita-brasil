/**
 * EDITA BRASIL - servidor unico (site + assinatura)
 * ---------------------------------------------------
 * Este arquivo faz DUAS coisas:
 *  1. Entrega o site (a pasta "public") para quem visitar o endereco.
 *  2. Cuida da assinatura: cria a sessao de pagamento no Stripe (com 7 dias
 *     de teste gratis) e confere quem tem acesso liberado, usando o Supabase
 *     como login (link magico por e-mail) e como banco de dados.
 *
 * O PDF de ninguem passa por aqui - a edicao inteira acontece no navegador
 * da pessoa. Este servidor so sabe se a pessoa logada tem assinatura ativa
 * ou nao.
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');

const STRIPE_SECRET_KEY = process.env.STRIPE_SECRET_KEY || '';
const STRIPE_PRICE_ID = process.env.STRIPE_PRICE_ID || '';
const STRIPE_WEBHOOK_SECRET = process.env.STRIPE_WEBHOOK_SECRET || '';
const SUPABASE_URL = process.env.SUPABASE_URL || '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY || '';
const TRIAL_DAYS = 7;
// O Render ja informa o proprio endereco publico automaticamente.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '';

const stripe = STRIPE_SECRET_KEY ? new Stripe(STRIPE_SECRET_KEY) : null;
const supabaseAdmin = (SUPABASE_URL && SUPABASE_SERVICE_KEY) ? createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY) : null;

const app = express();
app.use(cors());

// ---------------------------------------------------------------------------
// Webhook do Stripe - PRECISA vir antes do express.json() global, porque o
// Stripe exige o corpo "cru" (sem ser transformado em objeto) para conferir
// a assinatura da chamada e garantir que ela realmente veio do Stripe.
// ---------------------------------------------------------------------------
app.post('/api/stripe-webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  if (!stripe || !STRIPE_WEBHOOK_SECRET) return res.status(500).send('Stripe nao configurado.');
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, req.headers['stripe-signature'], STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.warn('[stripe-webhook] assinatura invalida:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  try {
    const obj = event.data.object;
    if (event.type === 'checkout.session.completed' || event.type === 'customer.subscription.created' || event.type === 'customer.subscription.updated') {
      const subscriptionId = obj.subscription || obj.id;
      const customerId = obj.customer;
      const userId = obj.client_reference_id || (obj.metadata && obj.metadata.user_id) || null;
      let sub = obj;
      if (event.type === 'checkout.session.completed' && subscriptionId) {
        sub = await stripe.subscriptions.retrieve(subscriptionId);
      }
      if (userId && supabaseAdmin) {
        await supabaseAdmin.from('subscriptions').upsert({
          user_id: userId,
          email: sub.metadata && sub.metadata.email ? sub.metadata.email : undefined,
          stripe_customer_id: customerId,
          stripe_subscription_id: sub.id || subscriptionId,
          status: sub.status || 'active',
          current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
          updated_at: new Date().toISOString(),
        }, { onConflict: 'user_id' });
        console.log(`[stripe-webhook] assinatura atualizada para user ${userId}: ${sub.status || 'active'}`);
      }
    } else if (event.type === 'customer.subscription.deleted') {
      if (supabaseAdmin) {
        await supabaseAdmin.from('subscriptions').update({ status: 'canceled', updated_at: new Date().toISOString() }).eq('stripe_subscription_id', obj.id);
      }
    }
  } catch (err) {
    console.error('[stripe-webhook] erro processando evento:', err.message);
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------------------------------------------------------------------------
// Assinatura (Stripe + Supabase)
// ---------------------------------------------------------------------------

// Confere o "cracha" (token) que o navegador manda, e descobre quem e a pessoa.
async function getUserFromRequest(req) {
  if (!supabaseAdmin) return null;
  const authHeader = req.headers.authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : null;
  if (!token) return null;
  const { data, error } = await supabaseAdmin.auth.getUser(token);
  if (error || !data || !data.user) return null;
  return data.user;
}

// Diz se a pessoa logada pode usar o editor livremente (assinatura ativa ou em teste).
app.get('/api/subscription-status', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Nao autenticado.' });
  if (!supabaseAdmin) return res.status(500).json({ error: 'Supabase nao configurado.' });

  const { data, error } = await supabaseAdmin.from('subscriptions').select('*').eq('user_id', user.id).maybeSingle();
  if (error) return res.status(500).json({ error: error.message });

  let status = data ? data.status : 'none';

  // Se ainda nao sabemos de uma assinatura ativa por aqui, confere direto com
  // o Stripe (nao depende so do webhook ter funcionado).
  if ((status === 'none' || status === 'canceled') && stripe && user.email) {
    try {
      const customers = await stripe.customers.list({ email: user.email, limit: 1 });
      if (customers.data.length) {
        const subs = await stripe.subscriptions.list({ customer: customers.data[0].id, status: 'all', limit: 1 });
        if (subs.data.length) {
          const sub = subs.data[0];
          status = sub.status;
          if (supabaseAdmin) {
            await supabaseAdmin.from('subscriptions').upsert({
              user_id: user.id, email: user.email,
              stripe_customer_id: customers.data[0].id, stripe_subscription_id: sub.id,
              status: sub.status,
              current_period_end: sub.current_period_end ? new Date(sub.current_period_end * 1000).toISOString() : null,
              updated_at: new Date().toISOString(),
            }, { onConflict: 'user_id' });
          }
        }
      }
    } catch (err) {
      console.warn('[stripe] falha ao conferir assinatura diretamente:', err.message);
    }
  }

  const hasAccess = status === 'trialing' || status === 'active';
  res.json({ status, hasAccess });
});

// Cria o link de pagamento do Stripe (assinatura com 7 dias gratis).
app.post('/api/create-checkout-session', async (req, res) => {
  const user = await getUserFromRequest(req);
  if (!user) return res.status(401).json({ error: 'Nao autenticado.' });
  if (!stripe || !STRIPE_PRICE_ID) return res.status(500).json({ error: 'Stripe nao configurado.' });

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'subscription',
      line_items: [{ price: STRIPE_PRICE_ID, quantity: 1 }],
      subscription_data: {
        trial_period_days: TRIAL_DAYS,
        metadata: { user_id: user.id, email: user.email },
      },
      client_reference_id: user.id,
      customer_email: user.email,
      success_url: `${PUBLIC_BASE_URL}/?assinatura=sucesso`,
      cancel_url: `${PUBLIC_BASE_URL}/?assinatura=cancelada`,
    });
    res.json({ url: session.url });
  } catch (err) {
    console.error('[stripe] erro criando checkout session:', err.message);
    res.status(500).json({ error: 'Nao foi possivel iniciar a assinatura agora.' });
  }
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Sitelinks / URLs alternativas para o Google Ads.
// Qualquer endereco que nao seja de API (ex: /1, /2, /recursos, /curriculo)
// mostra o mesmo site - assim da para usar varias URLs diferentes nos
// sitelinks do anuncio, todas levando para a mesma pagina.
// ---------------------------------------------------------------------------
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/')) return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EDITA BRASIL rodando na porta ${PORT}`);
  if (!STRIPE_SECRET_KEY) console.warn('Aviso: STRIPE_SECRET_KEY nao definido.');
  if (!STRIPE_PRICE_ID) console.warn('Aviso: STRIPE_PRICE_ID nao definido.');
  if (!STRIPE_WEBHOOK_SECRET) console.warn('Aviso: STRIPE_WEBHOOK_SECRET nao definido - webhook nao vai validar.');
  if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) console.warn('Aviso: Supabase nao configurado (SUPABASE_URL / SUPABASE_SERVICE_KEY).');
});
