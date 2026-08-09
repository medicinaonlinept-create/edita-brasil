/**
 * EDITA BRASIL - servidor unico (site + pagamento)
 * -------------------------------------------------
 * Este arquivo faz DUAS coisas:
 *  1. Entrega o site (a pasta "public") para quem visitar o endereco.
 *  2. Cuida do pagamento: cria a cobranca na IronPay e libera o download
 *     quando o pagamento e confirmado.
 *
 * Ele NAO recebe nem guarda o PDF de ninguem - isso continua acontecendo so
 * no navegador da pessoa. O servidor so sabe se um pedido foi pago ou nao.
 */

require('dotenv').config();
const path = require('path');
const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const fetch = require('node-fetch');

const app = express();
app.use(cors());
app.use(express.json({ limit: '200kb' }));
app.use(express.static(path.join(__dirname, 'public')));

const PRICE_CENTS = parseInt(process.env.PRICE_CENTS || '990', 10);
const IRONPAY_API_TOKEN = process.env.IRONPAY_API_KEY || '';
const IRONPAY_OFFER_HASH = process.env.IRONPAY_OFFER_HASH || '';
const IRONPAY_PRODUCT_HASH = process.env.IRONPAY_PRODUCT_HASH || '';
// O Render (e servicos parecidos) ja informam o proprio endereco publico
// automaticamente. Se voce estiver usando outro servico, pode preencher
// PUBLIC_BASE_URL manualmente no .env.
const PUBLIC_BASE_URL = process.env.PUBLIC_BASE_URL || process.env.RENDER_EXTERNAL_URL || '';
const IRONPAY_BASE = 'https://api.ironpayapp.com.br/api/public/v1';

// ---------------------------------------------------------------------------
// Pedidos em memoria (orderId -> {status, createdAt, ironpayHash})
// ---------------------------------------------------------------------------
const orders = new Map();
function makeOrderId() { return crypto.randomBytes(12).toString('hex'); }

setInterval(() => {
  const cutoff = Date.now() - 2 * 60 * 60 * 1000;
  for (const [id, order] of orders) {
    if (order.status === 'pending' && order.createdAt < cutoff) orders.delete(id);
  }
}, 30 * 60 * 1000);

// ---------------------------------------------------------------------------
// Cliente HTTP para a IronPay
// ---------------------------------------------------------------------------
async function ironpayRequest(path, { method = 'GET', body } = {}) {
  if (!IRONPAY_API_TOKEN) throw new Error('IRONPAY_API_KEY nao configurado');
  const sep = path.includes('?') ? '&' : '?';
  const url = `${IRONPAY_BASE}${path}${sep}api_token=${encodeURIComponent(IRONPAY_API_TOKEN)}`;
  const res = await fetch(url, {
    method,
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await res.text();
  let data;
  try { data = JSON.parse(text); } catch { data = { raw: text }; }
  if (!res.ok) {
    const err = new Error(`IronPay respondeu ${res.status} em ${path}`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function createIronPayTransaction({ amountCents, customer }) {
  const body = {
    amount: amountCents,
    offer_hash: IRONPAY_OFFER_HASH,
    payment_method: 'pix',
    customer: {
      name: customer.name, email: customer.email, phone_number: customer.phone, document: customer.document,
      street_name: customer.street, number: customer.number, complement: customer.complement || '',
      neighborhood: customer.neighborhood, city: customer.city, state: customer.state, zip_code: customer.zipCode,
    },
    cart: [{
      product_hash: IRONPAY_PRODUCT_HASH, title: 'EDITA BRASIL - Edicao de 1 arquivo PDF', cover: 'https://placehold.co/512x512/0E8A46/FFFFFF?text=EDITA+BRASIL',
      price: amountCents, quantity: 1, operation_type: 1, tangible: false,
    }],
    expire_in_days: 1,
    transaction_origin: 'api',
    tracking: { src: '', utm_source: '', utm_medium: '', utm_campaign: '', utm_term: '', utm_content: '' },
    postback_url: PUBLIC_BASE_URL ? `${PUBLIC_BASE_URL}/api/webhook/ironpay` : undefined,
  };

  const data = await ironpayRequest('/transactions', { method: 'POST', body });
  const hash = data.hash || data.transaction_hash || (data.data && data.data.hash) || null;
  const pix = data.pix || (data.data && data.data.pix) || {};
  const pixCode = pix.qrcode || pix.qr_code || pix.code || pix.emv || data.qr_code || data.pix_qrcode || null;
  const qrCodeImage = pix.qrcode_image || pix.qr_code_base64 || pix.image || data.qr_code_image || null;

  if (!hash) console.warn('[ironpay] nao encontrei "hash" na resposta da transacao:', JSON.stringify(data));
  if (!pixCode) console.warn('[ironpay] nao encontrei o codigo PIX na resposta da transacao:', JSON.stringify(data));

  return { ironpayHash: hash, pixCode, qrCodeImage, raw: data };
}

async function fetchIronPayTransactionStatus(hash) {
  const data = await ironpayRequest(`/transactions/${hash}`);
  return (data.status || (data.data && data.data.status) || '').toString().toLowerCase();
}

// ---------------------------------------------------------------------------
// Rotas de pagamento
// ---------------------------------------------------------------------------
app.post('/api/orders', async (req, res) => {
  const customer = (req.body && req.body.customer) || {};
  const required = ['name', 'email', 'phone', 'document', 'street', 'number', 'neighborhood', 'city', 'state', 'zipCode'];
  const missing = required.filter(f => !customer[f]);
  if (missing.length) return res.status(400).json({ error: `Faltam dados do cliente: ${missing.join(', ')}` });
  if (!IRONPAY_OFFER_HASH || !IRONPAY_PRODUCT_HASH) {
    return res.status(500).json({ error: 'O produto ainda nao foi criado na IronPay. Acesse /setup primeiro.' });
  }

  const orderId = makeOrderId();
  orders.set(orderId, { status: 'pending', createdAt: Date.now(), ironpayHash: null });
  try {
    const charge = await createIronPayTransaction({ amountCents: PRICE_CENTS, customer });
    orders.get(orderId).ironpayHash = charge.ironpayHash;
    res.json({ orderId, priceCents: PRICE_CENTS, pixCode: charge.pixCode, qrCodeImage: charge.qrCodeImage });
  } catch (err) {
    console.error('Erro criando transacao IronPay:', err.status || '', err.data || err.message);
    orders.delete(orderId);
    res.status(502).json({ error: 'Nao foi possivel gerar a cobranca agora. Tente novamente em instantes.' });
  }
});

app.get('/api/orders/:id', async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido nao encontrado.' });
  if (order.status === 'pending' && order.ironpayHash) {
    try {
      const liveStatus = await fetchIronPayTransactionStatus(order.ironpayHash);
      if (liveStatus === 'paid') order.status = 'paid';
      else if (liveStatus === 'canceled' || liveStatus === 'refunded') order.status = liveStatus;
    } catch (err) { console.warn('Falha ao consultar status na IronPay:', err.message); }
  }
  res.json({ status: order.status });
});

app.post('/api/webhook/ironpay', async (req, res) => {
  const payload = req.body || {};
  const hash = payload.hash || payload.transaction_hash || (payload.data && payload.data.hash) || null;
  if (!hash) return res.status(200).json({ received: true, matched: false });
  let matchedOrderId = null;
  for (const [id, order] of orders) if (order.ironpayHash === hash) { matchedOrderId = id; break; }
  if (!matchedOrderId) return res.status(200).json({ received: true, matched: false });
  try {
    const liveStatus = await fetchIronPayTransactionStatus(hash);
    if (liveStatus === 'paid') orders.get(matchedOrderId).status = 'paid';
  } catch (err) { console.warn('[webhook] erro confirmando status:', err.message); }
  res.status(200).json({ received: true, matched: true });
});

app.get('/api/health', (req, res) => res.json({ ok: true }));

// ---------------------------------------------------------------------------
// Pagina /setup - cria o Produto e a Oferta na IronPay com um clique.
// Substitui a necessidade de rodar qualquer coisa no terminal.
// ---------------------------------------------------------------------------
app.post('/api/setup/create-product', async (req, res) => {
  try {
    if (!IRONPAY_API_TOKEN) throw new Error('Defina IRONPAY_API_KEY nas variaveis de ambiente antes de continuar.');

    const prod = await ironpayRequest('/products', {
      method: 'POST',
      body: {
        title: 'EDITA BRASIL - Edicao de PDF',
        cover: 'https://placehold.co/512x512/0E8A46/FFFFFF?text=EDITA+BRASIL',
        sale_page: PUBLIC_BASE_URL || 'https://editabrasil.com.br',
        payment_type: 1, product_type: 'digital', delivery_type: 1, id_category: 1,
        amount: PRICE_CENTS, price: PRICE_CENTS,
      },
    });
    const productHash = prod.hash || (prod.data && prod.data.hash);
    if (!productHash) return res.status(500).json({ error: 'A IronPay respondeu, mas nao encontrei o "hash" do produto.', raw: prod });

    const offer = await ironpayRequest(`/products/${productHash}/offers`, {
      method: 'POST',
      body: {
        title: 'Edicao unica de PDF', cover: 'https://placehold.co/512x512/0E8A46/FFFFFF?text=EDITA+BRASIL',
        amount: PRICE_CENTS, price: PRICE_CENTS,
      },
    });
    const offerHash = offer.hash || (offer.data && offer.data.hash);
    if (!offerHash) return res.status(500).json({ error: 'A IronPay respondeu, mas nao encontrei o "hash" da oferta.', raw: offer });

    res.json({ productHash, offerHash });
  } catch (err) {
    console.error('Erro no /api/setup/create-product:', err.status || '', err.data || err.message);
    res.status(500).json({ error: (err.data && JSON.stringify(err.data)) || err.message });
  }
});

app.get('/setup', (req, res) => {
  res.type('html').send(`<!DOCTYPE html>
<html lang="pt-BR"><head><meta charset="UTF-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Configuração — EDITA BRASIL</title>
<style>
  body{font-family:-apple-system,Inter,Arial,sans-serif;background:#F5F6F3;color:#1B1F23;max-width:520px;margin:40px auto;padding:0 20px;line-height:1.6;}
  h1{font-size:22px;} .card{background:#fff;border:1px solid #E4E6E1;border-radius:12px;padding:20px;margin-top:16px;}
  button{background:#0E8A46;color:#fff;border:none;font-weight:700;font-size:15px;padding:13px 20px;border-radius:8px;cursor:pointer;width:100%;}
  button:disabled{background:#ccc;}
  code{background:#F5F6F3;padding:2px 6px;border-radius:4px;font-size:13px;display:block;margin-top:6px;word-break:break-all;}
  .ok{color:#0E8A46;font-weight:700;} .err{color:#D64545;font-weight:700;}
  .status{margin-top:14px; padding:12px; border-radius:8px; background:#F5F6F3; font-size:13px;}
</style></head>
<body>
  <h1>Configuração do EDITA BRASIL</h1>
  <p>Esta página cria o Produto e a Oferta na IronPay. Só precisa fazer isso <b>uma vez</b>.</p>
  <div class="card">
    <div class="status" id="currentStatus">Verificando...</div>
    <button id="btn">Criar produto e oferta na IronPay</button>
    <div id="result"></div>
  </div>
  <script>
    const statusEl = document.getElementById('currentStatus');
    statusEl.textContent = ${JSON.stringify(!!(IRONPAY_PRODUCT_HASH && IRONPAY_OFFER_HASH))}
      ? 'Produto e oferta já configurados. Você pode rodar de novo se precisar recriar.'
      : 'Ainda não configurado. Clique no botão abaixo.';
    document.getElementById('btn').addEventListener('click', async () => {
      const btn = document.getElementById('btn');
      const result = document.getElementById('result');
      btn.disabled = true; btn.textContent = 'Criando...';
      result.innerHTML = '';
      try {
        const res = await fetch('/api/setup/create-product', { method: 'POST' });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error || 'Erro desconhecido');
        result.innerHTML = '<p class="ok">Pronto! Copie estes dois valores para as variáveis de ambiente do seu servidor:</p>' +
          '<code>IRONPAY_PRODUCT_HASH=' + data.productHash + '</code>' +
          '<code>IRONPAY_OFFER_HASH=' + data.offerHash + '</code>' +
          '<p style="margin-top:10px;">Depois de colar e salvar, o serviço reinicia sozinho e está tudo pronto.</p>';
      } catch (err) {
        result.innerHTML = '<p class="err">Não deu certo: ' + err.message + '</p><p>Copie essa mensagem e envie para o Claude corrigir.</p>';
      } finally {
        btn.disabled = false; btn.textContent = 'Criar produto e oferta na IronPay';
      }
    });
  </script>
</body></html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EDITA BRASIL rodando na porta ${PORT}`);
  if (!IRONPAY_API_TOKEN) console.warn('Aviso: IRONPAY_API_KEY nao definido.');
  if (!IRONPAY_OFFER_HASH) console.warn('Aviso: acesse /setup para criar o produto e a oferta.');
});
