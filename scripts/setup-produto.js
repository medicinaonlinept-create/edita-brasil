/**
 * Rode este script UMA VEZ para criar o Produto e a Oferta na IronPay.
 * Ele imprime no final a linha que voce deve colar no seu .env.
 *
 * Como rodar:
 *   1. Preencha IRONPAY_API_KEY no .env
 *   2. node scripts/setup-produto.js
 */
require('dotenv').config();
const fetch = require('node-fetch');

const API_TOKEN = process.env.IRONPAY_API_KEY;
const PRICE_CENTS = parseInt(process.env.PRICE_CENTS || '990', 10);
const BASE = 'https://api.ironpayapp.com.br/api/public/v1';

async function main() {
  if (!API_TOKEN) {
    console.error('Defina IRONPAY_API_KEY no arquivo .env antes de rodar este script.');
    process.exit(1);
  }

  console.log('Criando produto na IronPay...');
  const prodRes = await fetch(`${BASE}/products?api_token=${encodeURIComponent(API_TOKEN)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      title: 'EDITA BRASIL - Edicao de PDF',
      cover: null,
      sale_page: 'https://editabrasil.com.br',
      payment_type: 1,
      product_type: 'digital',
      delivery_type: 1,
      id_category: 1,
      amount: PRICE_CENTS,
    }),
  });
  const prod = await prodRes.json().catch(() => ({}));
  console.log(`HTTP ${prodRes.status} - resposta completa do produto:`);
  console.log(JSON.stringify(prod, null, 2));
  if (!prodRes.ok) {
    console.error('\nA IronPay recusou a criacao do produto (veja a resposta acima). Corrija e rode de novo.');
    process.exit(1);
  }

  const productHash = prod.hash || (prod.data && prod.data.hash);
  if (!productHash) {
    console.error('\nNao encontrei o campo "hash" na resposta acima.');
    console.error('Copie a resposta completa e me envie no chat para eu ajustar o script.');
    process.exit(1);
  }
  console.log(`\nProduto criado com hash: ${productHash}`);

  console.log(`\nCriando oferta de R$ ${(PRICE_CENTS / 100).toFixed(2)} para o produto...`);
  const offerRes = await fetch(`${BASE}/products/${productHash}/offers?api_token=${encodeURIComponent(API_TOKEN)}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
    body: JSON.stringify({
      title: 'Edicao unica de PDF',
      cover: null,
      amount: PRICE_CENTS,
    }),
  });
  const offer = await offerRes.json().catch(() => ({}));
  console.log(`HTTP ${offerRes.status} - resposta completa da oferta:`);
  console.log(JSON.stringify(offer, null, 2));
  if (!offerRes.ok) {
    console.error('\nA IronPay recusou a criacao da oferta (veja a resposta acima). Corrija e rode de novo.');
    process.exit(1);
  }

  const offerHash = offer.hash || (offer.data && offer.data.hash);
  if (!offerHash) {
    console.error('\nNao encontrei o campo "hash" na resposta da oferta acima.');
    console.error('Copie a resposta completa e me envie no chat para eu ajustar o script.');
    process.exit(1);
  }

  console.log('\n------------------------------------------------------------');
  console.log('Tudo certo! Copie estas duas linhas para o seu arquivo .env:');
  console.log(`IRONPAY_PRODUCT_HASH=${productHash}`);
  console.log(`IRONPAY_OFFER_HASH=${offerHash}`);
  console.log('------------------------------------------------------------');
}

main().catch(err => {
  console.error('Erro inesperado:', err);
  process.exit(1);
});
