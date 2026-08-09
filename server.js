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
const QRCode = require('qrcode');

const app = express();
app.use(cors());
app.use(express.json({ limit: '25mb' }));
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

const EMAILJS_SERVICE_ID = process.env.EMAILJS_SERVICE_ID || '';
const EMAILJS_TEMPLATE_PIX = process.env.EMAILJS_TEMPLATE_PIX || '';
const EMAILJS_TEMPLATE_PAID = process.env.EMAILJS_TEMPLATE_PAID || '';
const EMAILJS_PUBLIC_KEY = process.env.EMAILJS_PUBLIC_KEY || '';
const EMAILJS_PRIVATE_KEY = process.env.EMAILJS_PRIVATE_KEY || '';

// ---------------------------------------------------------------------------
// Pedidos em memoria (orderId -> {status, createdAt, ironpayHash})
// ---------------------------------------------------------------------------
const orders = new Map();
function makeOrderId() { return crypto.randomBytes(12).toString('hex'); }

setInterval(() => {
  const cutoffPending = Date.now() - 2 * 60 * 60 * 1000;
  const cutoffPaid = Date.now() - 48 * 60 * 60 * 1000;
  for (const [id, order] of orders) {
    if (order.status === 'pending' && order.createdAt < cutoffPending) orders.delete(id);
    else if (order.status === 'paid' && order.createdAt < cutoffPaid) orders.delete(id);
  }
}, 30 * 60 * 1000);

// ---------------------------------------------------------------------------
// Envio de e-mails via EmailJS (a partir do servidor, usando a Private Key)
// ---------------------------------------------------------------------------
async function sendEmailViaEmailJS(templateId, templateParams) {
  if (!EMAILJS_SERVICE_ID || !EMAILJS_PUBLIC_KEY || !EMAILJS_PRIVATE_KEY) {
    console.warn('[emailjs] variaveis de ambiente do EmailJS nao configuradas - e-mail nao enviado.');
    return;
  }
  const res = await fetch('https://api.emailjs.com/api/v1.0/email/send', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      service_id: EMAILJS_SERVICE_ID,
      template_id: templateId,
      user_id: EMAILJS_PUBLIC_KEY,
      accessToken: EMAILJS_PRIVATE_KEY,
      template_params: templateParams,
    }),
  });
  if (!res.ok) {
    const text = await res.text().catch(() => '');
    throw new Error(`EmailJS respondeu ${res.status}: ${text}`);
  }
}

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
  // Endereco fixo do vendedor - a IronPay exige esses campos no cadastro do
  // cliente, mas o formulario do site so pede nome, e-mail, telefone e CPF
  // (igual ao link de checkout deles), entao completamos o resto aqui.
  const FIXED_ADDRESS = {
    street_name: 'Rua Luiz França', number: '526', complement: '',
    neighborhood: 'Cajuru', city: 'Curitiba', state: 'PR', zip_code: '82900250',
  };
  const body = {
    amount: amountCents,
    offer_hash: IRONPAY_OFFER_HASH,
    payment_method: 'pix',
    customer: {
      name: customer.name, email: customer.email, phone_number: customer.phone, document: customer.document,
      ...FIXED_ADDRESS,
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
  const pixCode = pix.pix_qr_code || pix.qrcode || pix.qr_code || pix.code || pix.emv || data.qr_code || data.pix_qrcode || null;
  let qrCodeImage = pix.qrcode_image || pix.qr_code_base64 || pix.image || data.qr_code_image || null;

  if (!hash) console.warn('[ironpay] nao encontrei "hash" na resposta da transacao:', JSON.stringify(data));
  if (!pixCode) console.warn('[ironpay] nao encontrei o codigo PIX na resposta da transacao:', JSON.stringify(data));

  // A IronPay nem sempre manda uma imagem de QR Code pronta - quando isso
  // acontece, geramos a imagem aqui mesmo a partir do codigo copia-e-cola.
  if (!qrCodeImage && pixCode) {
    try {
      qrCodeImage = await QRCode.toDataURL(pixCode, { margin: 1, width: 300 });
    } catch (err) {
      console.warn('[ironpay] falha ao gerar QR Code localmente:', err.message);
    }
  }

  return { ironpayHash: hash, pixCode, qrCodeImage, raw: data };
}

async function fetchIronPayTransactionStatus(hash) {
  const data = await ironpayRequest(`/transactions/${hash}`);
  const status = data.payment_status || data.status || (data.data && (data.data.payment_status || data.data.status)) || '';
  return status.toString().toLowerCase();
}

// ---------------------------------------------------------------------------
// Rotas de pagamento
// ---------------------------------------------------------------------------
app.post('/api/orders', async (req, res) => {
  const customer = (req.body && req.body.customer) || {};
  const fileBase64 = req.body && req.body.fileBase64;
  const fileName = (req.body && req.body.fileName) || 'documento-editado.pdf';
  const required = ['name', 'email', 'phone', 'document'];
  const missing = required.filter(f => !customer[f]);
  if (missing.length) return res.status(400).json({ error: `Faltam dados do cliente: ${missing.join(', ')}` });
  if (!IRONPAY_OFFER_HASH || !IRONPAY_PRODUCT_HASH) {
    return res.status(500).json({ error: 'O produto ainda nao foi criado na IronPay. Acesse /setup primeiro.' });
  }

  const orderId = makeOrderId();
  orders.set(orderId, {
    status: 'pending', createdAt: Date.now(), ironpayHash: null,
    customer: { name: customer.name, email: customer.email },
    fileBuffer: fileBase64 ? Buffer.from(fileBase64, 'base64') : null,
    fileName,
    emailSentPaid: false,
  });

  try {
    const charge = await createIronPayTransaction({ amountCents: PRICE_CENTS, customer });
    orders.get(orderId).ironpayHash = charge.ironpayHash;
    res.json({ orderId, priceCents: PRICE_CENTS, pixCode: charge.pixCode, qrCodeImage: charge.qrCodeImage });

    // Dispara o e-mail com o Pix - nao trava a resposta pro navegador esperando isso.
    if (charge.pixCode) {
      const qrUrlForEmail = `https://api.qrserver.com/v1/create-qr-code/?size=280x280&data=${encodeURIComponent(charge.pixCode)}`;
      sendEmailViaEmailJS(EMAILJS_TEMPLATE_PIX, {
        to_email: customer.email,
        customer_name: customer.name,
        qr_code_url: qrUrlForEmail,
        pix_code: charge.pixCode,
      }).catch(err => console.warn('[emailjs] falha ao enviar e-mail do Pix:', err.message));
    }
  } catch (err) {
    console.error('Erro criando transacao IronPay:', err.status || '', err.data || err.message);
    orders.delete(orderId);
    res.status(502).json({ error: 'Nao foi possivel gerar a cobranca agora. Tente novamente em instantes.' });
  }
});

// Dispara (uma unica vez) o e-mail de "pagamento confirmado" com o link de download.
function notifyPaidIfNeeded(orderId, order) {
  if (order.emailSentPaid || !order.customer || !order.customer.email) return;
  order.emailSentPaid = true;
  const downloadLink = `${PUBLIC_BASE_URL || ''}/api/download/${orderId}`;
  sendEmailViaEmailJS(EMAILJS_TEMPLATE_PAID, {
    to_email: order.customer.email,
    customer_name: order.customer.name,
    download_link: downloadLink,
  }).catch(err => console.warn('[emailjs] falha ao enviar e-mail de confirmacao:', err.message));
}

// Libera o arquivo somente se o pedido estiver marcado como pago.
app.get('/api/download/:id', (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).send('Link invalido ou expirado.');
  if (order.status !== 'paid') return res.status(402).send('Pagamento ainda nao confirmado.');
  if (!order.fileBuffer) return res.status(404).send('Arquivo nao encontrado (pode ter expirado).');
  res.set('Content-Type', 'application/pdf');
  res.set('Content-Disposition', `attachment; filename="${order.fileName}"`);
  res.send(order.fileBuffer);
});

app.get('/api/orders/:id', async (req, res) => {
  const order = orders.get(req.params.id);
  if (!order) return res.status(404).json({ error: 'Pedido nao encontrado.' });
  if (order.status === 'pending' && order.ironpayHash) {
    try {
      const liveStatus = await fetchIronPayTransactionStatus(order.ironpayHash);
      if (liveStatus.includes('paid') || liveStatus.includes('approved') || liveStatus.includes('completed')) {
        order.status = 'paid';
        notifyPaidIfNeeded(req.params.id, order);
      }
      else if (liveStatus.includes('cancel') || liveStatus.includes('refund')) order.status = liveStatus;
      else console.log(`[status] pedido ${req.params.id} ainda nao reconhecido como pago. Status atual da IronPay: "${liveStatus}"`);
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
    if (liveStatus.includes('paid') || liveStatus.includes('approved') || liveStatus.includes('completed')) {
      const order = orders.get(matchedOrderId);
      order.status = 'paid';
      notifyPaidIfNeeded(matchedOrderId, order);
    }
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

// ---------------------------------------------------------------------------
// Sitelinks / URLs alternativas para o Google Ads.
// Qualquer endereço que nao seja de API (ex: /1, /2, /recursos, /curriculo)
// mostra o mesmo site - assim da para usar varias URLs diferentes nos
// sitelinks do anuncio, todas levando para a mesma pagina.
// ---------------------------------------------------------------------------
app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api/') || req.path === '/setup') return next();
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`EDITA BRASIL rodando na porta ${PORT}`);
  if (!IRONPAY_API_TOKEN) console.warn('Aviso: IRONPAY_API_KEY nao definido.');
  if (!IRONPAY_OFFER_HASH) console.warn('Aviso: acesse /setup para criar o produto e a oferta.');
});
