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

## 🗄️ Estrutura do Banco de Dados PostgreSQL

As tabelas são criadas automaticamente ao iniciar o backend:

- **`payments`**:
  - `id`: Chave primária auto-incremento
  - `transaction_id`: ID da transação da EscalaPay
  - `customer_email`: Email do comprador
  - `amount`: Valor da transação
  - `currency`: Moeda (ex: `BRL`)
  - `status`: Status do pagamento (`paid`, `approved`, `pending`, etc.)
  - `gateway`: `escalapay`
  - `payload`: Dados completos enviados no webhook em JSONB
  - `created_at` / `updated_at`: Timestamps

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
