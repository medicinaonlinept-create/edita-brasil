# EDITA BRASIL

Este é o site inteiro (a parte que as pessoas veem + a parte que cobra o
pagamento), tudo numa pasta só. Você não precisa escrever nem editar
nenhuma linha de código — só seguir os passos abaixo, na ordem.

Se quiser, peça para o Claude te guiar passo a passo em vez de ler tudo de
uma vez.

## O que vai acontecer, em resumo

1. Você coloca esta pasta num site chamado GitHub (é só um lugar para
   guardar os arquivos - gratuito).
2. Você conecta essa pasta a um site chamado Render (é quem vai deixar seu
   site no ar 24 horas por dia - também tem plano gratuito).
3. Você clica em um botão dentro do próprio site para ligar o pagamento.

Pronto, o site está no ar.

## Passo 1 — Criar conta no GitHub

Vá em https://github.com e crie uma conta gratuita (só pede e-mail e senha).

## Passo 2 — Subir esta pasta para o GitHub

1. Depois de logado, clique no `+` no canto superior direito → **New repository**
2. Dê um nome, por exemplo `edita-brasil` → **Create repository**
3. Na página do repositório, clique em **uploading an existing file**
4. Arraste os arquivos desta pasta para dentro da página — **menos um**:
   ⚠️ **NÃO arraste o arquivo chamado `.env`** (sem nome antes do ponto). Esse
   arquivo tem sua chave secreta da IronPay, e o GitHub é público — qualquer
   pessoa poderia ver. Arraste todos os outros arquivos e pastas normalmente.
   A chave você vai colocar direto no Render, no Passo 3.

(Não precisa instalar nada nem usar terminal — é só arrastar e soltar.)

## Passo 3 — Colocar o site no ar (Render)

1. Vá em https://render.com e crie uma conta gratuita (dá para entrar
   direto com a conta do GitHub, clicando em "Sign in with GitHub")
2. No painel, clique em **New +** → **Web Service**
3. Escolha o repositório `edita-brasil` que você acabou de criar
4. Deixe as opções como estão e desça até **Environment Variables**
5. Adicione uma variável:
   - Nome: `IRONPAY_API_KEY`
   - Valor: seu token da IronPay (o que você já me passou)
6. Clique em **Create Web Service**

O Render vai mostrar um monte de texto passando na tela — é normal, é ele
preparando o site. Quando aparecer "Live" em verde no topo, está pronto.
Você vai ganhar um endereço parecido com:

`https://edita-brasil.onrender.com`

Esse já é o site funcionando (a edição de PDF já funciona nesse endereço).

## Passo 4 — Ligar o pagamento (um clique)

1. Abra `https://SEU-ENDERECO.onrender.com/setup` (troque pelo seu endereço)
2. Clique no botão **"Criar produto e oferta na IronPay"**
3. A página vai mostrar duas linhas de código. Copie as duas.
4. Volte no Render, na página do seu site → **Environment** → **Add Environment Variable**,
   e adicione as duas linhas que você copiou (uma de cada vez)
5. Clique em **Save Changes** — o Render reinicia o site sozinho

Pronto. Agora, quando alguém clicar em "Baixar" no site, vai aparecer a
cobrança de R$ 9,90 de verdade.

## Passo 5 — Testar com dinheiro de verdade

Abra seu site, edite um PDF de teste, clique em Baixar, preencha o
formulário com seus próprios dados e pague o Pix de R$ 9,90. Confirme que
o arquivo baixa sozinho depois que o Pix cai.

## Se algo der errado

Copie a mensagem de erro (print da tela ou texto) e me mande no chat. A
maior parte dos problemas nessa fase é a IronPay usar um nome de campo um
pouco diferente do que eu previ no código - é uma correção rápida, uma vez
que eu vejo a mensagem exata.

## Sobre segurança

- O arquivo `.env` tem sua chave secreta e não deve ser subido para lugar
  nenhum público. No Render, o lugar certo para ela é a aba
  **Environment**, não dentro dos arquivos.
- Depois que tudo estiver funcionando, gere um novo token no painel da
  IronPay e troque no Render, já que o token atual foi digitado nesta
  conversa.
