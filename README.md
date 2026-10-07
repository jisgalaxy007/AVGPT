# AVGPT - Backend & Redirecionamento de Pagamento EscalaPay

Backend oficial do **AVGPT** hospedado no Fly.io (Johannesburg `jnb`) com PostgreSQL dedicado de 30GB e rota de redirecionamento profundo (Deep Linking) para abrir o aplicativo Android do cliente após a confirmação do pagamento no gateway EscalaPay.

---

## 🚀 Arquitetura e Recursos

1. **Backend Fly.io**: App `avgpt` (`https://avgpt.fly.dev`)
2. **Banco de Dados Fly PostgreSQL**: Cluster `avgpt-db` com 30GB de volume dedicado (Região: Johannesburg `jnb`)
3. **Deep Linking Android**: Esquema customizado `avgpt://pagamento-sucesso`
4. **Rota Solicitada**: `/pone` (e aliases `/pagamento-sucesso`, `/retorno`)
5. **Webhook EscalaPay**: `/webhook/escalapay` para salvar transações e atualizar status no banco
6. **Integração Binance (Leitura de Pagamentos)**:
   - Depósitos Cripto: `GET /api/binance/deposits`
   - Depósitos Fiat (BRL/PIX): `GET /api/binance/fiat`
   - Transações Binance Pay: `GET /api/binance/pay`
   - Saldos da Carteira: `GET /api/binance/balance`
   - Sincronização automática para o Postgres: `POST /api/binance/sync`

---

## 📱 Configuração no Aplicativo Android (AndroidManifest.xml)

Para que o celular do cliente abra o aplicativo AVGPT automaticamente quando o navegador acessar o redirecionamento, adicione o `intent-filter` dentro da sua `Activity` principal no arquivo `AndroidManifest.xml`:

```xml
<activity
    android:name=".MainActivity"
    android:exported="true"
    android:launchMode="singleTask">

    <!-- Intent Filter padrão do Launcher -->
    <intent-filter>
        <action android:name="android.intent.action.MAIN" />
        <category android:name="android.intent.category.LAUNCHER" />
    </intent-filter>

    <!-- Intent Filter para interceptar o Deep Link do EscalaPay -->
    <intent-filter>
        <action android:name="android.intent.action.VIEW" />
        <category android:name="android.intent.category.DEFAULT" />
        <category android:name="android.intent.category.BROWSABLE" />

        <!-- Intercepta: avgpt://pagamento-sucesso -->
        <data
            android:scheme="avgpt"
            android:host="pagamento-sucesso" />
    </intent-filter>

</activity>
```

### Capturando no código Android (Kotlin/Java):

```kotlin
// Em MainActivity.kt (onCreate ou onNewIntent):
override fun onNewIntent(intent: Intent?) {
    super.onNewIntent(intent)
    val data: Uri? = intent?.data
    if (data != null && data.scheme == "avgpt" && data.host == "pagamento-sucesso") {
        // Pagamento confirmado com sucesso!
        // Atualize a interface ou libere o acesso VIP / créditos do usuário
        Log.d("AVGPT", "Pagamento concluído! URI: $data")
    }
}
```

---

## 🌐 Configuração na EscalaPay

No painel da EscalaPay, configure:

- **URL de Retorno / Redirecionamento (Success URL)**:
  `https://avgpt.fly.dev/pone`
  *(Ou `https://avgpt.fly.dev/pagamento-sucesso`)*

- **URL do Webhook (Notification URL)**:
  `https://avgpt.fly.dev/webhook/escalapay` (Método `POST`)

---

## ⚙️ Script Executado na Rota `/pone`

Quando o cliente conclui o pagamento na EscalaPay e é redirecionado para `https://avgpt.fly.dev/pone`, a página é carregada contendo:

```html
<script>
  // Redireciona o navegador do cliente para abrir o app
  window.location.href = "avgpt://pagamento-sucesso";
</script>
```

Além disso, a página conta com um design moderno escuro com fallback visual e botão interativo caso o navegador móvel exija interação do usuário para disparar o aplicativo nativo.

---

## 🗄️ Estrutura do Banco de Dados PostgreSQL (Fly.io)

As tabelas são criadas e migradas automaticamente ao iniciar o backend:

### 1. `users` (Usuários e Aparelhos Android)
- `device_id`: Código Único do Celular (ex: `DEV-4A7B8C9D`) - Chave Primária
- `user_name`: Nome personalizável (padrão: `Jogador VIP`)
- `status`: `ATIVO`, `EXPIRADO` ou `TESTE`
- `plano`: Nome do plano (ex: `15 Dias VIP`)
- `validade_ate`: Data e hora de expiração da licença
- `data_registro` / `ultima_vez_online`: Timestamps de atividade
- `total_compras`: Total acumulado em MZN / USD
- `total_vezes_usou_bot`: Contador de uso do robô
- `total_lucro`, `ganhos_hoje`, `perdas_hoje`, `ganhos_ontem`, `perdas_ontem`, `ganhos_mes`, `perdas_mes`: Métricas financeiras

### 2. `casas` (Casas de Apostas)
- `id`: Identificador único (ex: `placard_mz`, `elephant_mz`)
- `nome`, `pais`, `descricao`, `link`: Dados da casa e link de afiliado/login
- `texto_botao`: Padrão `SINCRONIZAR E JOGAR AGORA`
- `rating`: 1 a 5 estrelas
- `badge`: Ex: `RECOMENDADA`, `POPULAR`, etc.
- `criado_em`: Data de criação

### 3. `planos` (Planos e Preços)
- `id`: Ex: `plano_1d`, `plano_7d`, `plano_15d`, `plano_30d`
- `nome`: Ex: `1 Dia VIP`, `7 Dias VIP`, `15 Dias VIP`, `30 Dias VIP`
- `dias`: Quantidade de dias de acesso (1, 7, 15, 30)
- `preco_mzn`: Preço em Meticais (350.00, 555.00, 799.00, 899.00)
- `preco_usdt`: Preço em USDT (6.00, 12.22, 15.55, 22.32)
- `periodo`, `is_popular`, `ativo`: Metadados

### 4. `configuracoes` (Configurações Globais)
- `id`: ID único (1)
- `suporte_link`: Link direto para WhatsApp / Telegram de suporte
- `aviso_admin`: Mensagem ou banner global de aviso para os jogadores
- `versao_minima`: Versão mínima obrigatória do aplicativo (ex: `1.0`)

### 5. `orders` (Pedidos Binance Pay por TXID)
- Rastreia pedidos criados e verifica unicidade de TXID da Binance para liberação de licenças.

### 6. `payments` (Histórico Unificado de Pagamentos)
- Registros consolidados de EscalaPay e depósitos Binance.

### 7. `mobile_payments` (e-Mola e M-Pesa - Moçambique)
- `service`: `emola` ou `mpesa`
- `tx_id`: ID único da transação (ex: `PP261004.2203.Y98273` ou `DJ37LT9PBN9`)
- `amount`: Valor recebido em Meticais (MT)
- `sender_phone`: Telefone do cliente (ex: `876563910` ou `258846079459`)
- `sender_name`: Nome do titular da conta
- `raw_message`: SMS completo original
- `status`: `RECEBIDO` ou `USADO`
- `usado_por_device_id`: Aparelho Android que utilizou o comprovativo
- `usado_em`: Data e hora em que foi resgatado
- `plano_ativado`: Nome do plano liberado (ex: `15 Dias VIP`)

---

## 🇲🇿 Fluxo Automatizado e-Mola & M-Pesa (SMS Gateway)

1. **Recepção do SMS**: O celular com o chip receptor recebe a notificação da operadora e o app gateway envia para:
   - `POST https://avgpt.fly.dev/api/mobile/webhook` com `{ "message": "ID Trans: PP..." }`
   - O backend extrai o ID e o valor e salva com status `RECEBIDO`.
2. **Resgate pelo Cliente**: O cliente transfere o dinheiro e cola a mensagem de confirmação no app AVGPT:
   - `POST https://avgpt.fly.dev/api/mobile/resgatar` com `{ "device_id": "DEV-...", "comprovativo": "..." }`
   - O backend extrai o TXID, verifica se existe, se não foi usado anteriormente, identifica o plano pelo valor em MT, marca como `USADO` e estende a validade do usuário instantaneamente!

---

## 🚀 Endpoints da API REST para o App Android

| Método | Endpoint | Descrição |
|---|---|---|
| `POST` | `/api/mobile/webhook` | **Gateway**: Envia o SMS puro recebido do e-Mola ou M-Pesa |
| `POST` | `/api/mobile/resgatar` | **Cliente**: Valida o comprovativo colado, impede reuso e libera a licença |
| `GET` | `/api/mobile/status/:txid` | Consulta o status de um TXID móvel |
| `GET` | `/api/mobile/transactions` | Lista os últimos pagamentos móveis recebidos |
| `POST` | `/api/mobile/parse` | Testa o extrator de SMS sem gravar no banco |
| `POST` | `/api/users/sync` | Login do aparelho (`device_id`). Cria ou atualiza e retorna validade/status |
| `GET` | `/api/users/:deviceId` | Consulta status do aparelho e verifica expiração |
| `POST` | `/api/users/stats` | Envia estatísticas de uso do bot e lucros |
| `GET` | `/api/casas` | Lista casas de apostas ativas |
| `POST` | `/api/casas` | Cadastra ou edita uma casa |
| `DELETE` | `/api/casas/:id` | Remove uma casa |
| `GET` | `/api/planos` | Lista planos VIP com preços em MZN e USDT |
| `POST` | `/api/planos` | Cria ou edita um plano |
| `GET` | `/api/configuracoes` | Obtém link de suporte, aviso admin e versão mínima |
| `POST` | `/api/configuracoes` | Atualiza link de suporte e avisos |
| `POST` | `/api/pagamento/criar` | Cria pedido Binance Pay com código de referência |
| `POST` | `/api/pagamento/verificar` | Valida TXID da Binance, evita reuso e libera a licença |
| `POST` | `/api/pagamento/validar-token` | Valida token de acesso persistente |

---

## 🛠️ Comandos de Manutenção

- **Ver logs em tempo real**:
  ```bash
  fly logs -a avgpt
  ```

- **Ver status das máquinas**:
  ```bash
  fly status -a avgpt
  fly status -a avgpt-db
  ```

- **Fazer novo deploy**:
  ```bash
  fly deploy
  ```
