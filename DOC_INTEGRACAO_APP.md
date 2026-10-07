# 📘 Guia de Integração da API AVGPT (Android Nativo)

Este documento contém todas as instruções, rotas, modelos de dados e exemplos de código para o desenvolvedor integrar o sistema de licenças, pagamentos (e-Mola, M-Pesa, Binance Pay) e sincronização de dados no aplicativo Android.

---

## 🌐 Informações Gerais da API

- **URL Base de Produção**: `https://avgpt.fly.dev`
- **Formato das Requisições**: `application/json`
- **Identificador Único do Aparelho (`device_id`)**:  
  Cada aparelho deve possuir um ID estável e persistente.
  *Exemplo no Android (Kotlin):*
  ```kotlin
  val deviceId = Settings.Secure.getString(context.contentResolver, Settings.Secure.ANDROID_ID)
  ```

---

## 📱 Fluxo 1: Abertura do App & Checagem de Licença (Splash / Login)

Toda vez que o usuário abre o aplicativo, o app deve sincronizar o aparelho com o servidor.

### Endpoint: `POST /api/users/sync`

Cadastra automaticamente novos aparelhos (com 15 dias VIP iniciais) ou atualiza a presença de usuários já existentes.

- **Headers**: `Content-Type: application/json`
- **Body**:
```json
{
  "device_id": "DEV-4A7B8C9D",
  "user_name": "Jogador VIP"
}
```

- **Resposta de Sucesso (200 / 201)**:
```json
{
  "success": true,
  "is_new": false,
  "data": {
    "device_id": "DEV-4A7B8C9D",
    "user_name": "Jogador VIP",
    "status": "ATIVO",
    "plano": "15 Dias VIP",
    "validade_ate": "2026-10-22T19:25:47.890Z",
    "total_compras": "0.00",
    "total_vezes_usou_bot": 12,
    "total_lucro": "1540.00"
  }
}
```

> **Lógica no App:**
> - Se `status == "ATIVO"` e a data atual for menor que `validade_ate`, **libera a tela principal do robô**.
> - Se `status == "EXPIRADO"`, **bloqueia o app e abre a tela de Pagamento / Renovação**.

---

## 🇲🇿 Fluxo 2: Pagamentos Locais (e-Mola e M-Pesa)

### Como funciona:
1. O app exibe na tela os números de envio e-Mola e M-Pesa e a tabela de preços (`GET /api/planos`).
2. O cliente realiza a transferência no telemóvel dele.
3. O cliente recebe o SMS de confirmação da Vodacom/Movitel.
4. O cliente **cola a mensagem inteira do SMS** (ou apenas o código de transação) num campo de texto e clica em **"Confirmar Pagamento"**.
5. O app chama o endpoint de resgate.

### Endpoint: `POST /api/mobile/resgatar`

- **Headers**: `Content-Type: application/json`
- **Body**:
```json
{
  "device_id": "DEV-4A7B8C9D",
  "comprovativo": "ID Trans: PP261004.2203.Y98273. Recebeu 269.00MT de 876563910, BERNARDINA A AGOSTINHO as 22:03:13 04/10/2026. Conteudo: cona. O seu novo saldo e de 309.19MT. Em caso de duvida, ligue para 100."
}
```
*(Nota: O cliente também pode colar apenas o ID direto, ex: `"comprovativo": "PP261004.2203.Y98273"` ou `"DJ37LT9PBN9"`)*

#### Respostas do Servidor:

#### ✅ 1. Sucesso (HTTP 200) - Licença Ativada
O backend reconhece o valor pago em Meticais, ativa o plano correspondente e estende a validade:
```json
{
  "sucesso": true,
  "status": "ativado",
  "mensagem": "🎉 Parabéns! Pagamento de 269.00 MT confirmado via EMOLA. O plano \"1 Dia(s) VIP\" foi ativado com sucesso!",
  "tx_id": "PP261004.2203.Y98273",
  "servico": "emola",
  "valor_mt": 269.0,
  "dias_adicionados": 1,
  "validade_ate": "2026-10-23T19:41:55.256Z",
  "user": {
    "device_id": "DEV-4A7B8C9D",
    "status": "ATIVO",
    "plano": "1 Dia(s) VIP",
    "validade_ate": "2026-10-23T19:41:55.256Z"
  }
}
```
*(Ação no App: Salvar os novos dados e liberar o acesso do usuário imediatamente).*

#### 🚫 2. Valor Incorreto / Não Corresponde a Nenhum Pacote (HTTP 422 Unprocessable Entity)
Se o valor pago for diferente dos pacotes cadastrados (ex: cliente transferiu 1 MT, 5 MT, 12 MT ou valor aleatório):
```json
{
  "sucesso": false,
  "status": "valor_invalido",
  "mensagem": "❌ O valor pago de 12.00 MT não corresponde a nenhum pacote VIP ativo. Valores válidos: 350.00 MT (1 Dia VIP), 555.00 MT (7 Dias VIP), 799.00 MT (15 Dias VIP), 899.00 MT (30 Dias VIP). Nenhuma licença foi ativada.",
  "valor_recebido": 12.0,
  "tx_id": "PP261005.0049.A49779",
  "planos_disponiveis": [
    { "id": "plano_1d", "nome": "1 Dia VIP", "preco_mzn": 350.0, "dias": 1 },
    { "id": "plano_7d", "nome": "7 Dias VIP", "preco_mzn": 555.0, "dias": 7 },
    { "id": "plano_15d", "nome": "15 Dias VIP", "preco_mzn": 799.0, "dias": 15 },
    { "id": "plano_30d", "nome": "30 Dias VIP", "preco_mzn": 899.0, "dias": 30 }
  ]
}
```
*(Ação no App: Exibir mensagem de erro alertando que o valor pago não confere com o plano e não liberar o robô).*

#### ⚠️ 3. Tentativa de Golpe / Comprovativo Já Usado (HTTP 409 Conflict)
```json
{
  "sucesso": false,
  "status": "ja_usado",
  "mensagem": "❌ Este comprovativo já foi utilizado anteriormente no aparelho DEV-OUTRO em 07/10/2026, 19:41:55!",
  "tx_id": "PP261004.2203.Y98273"
}
```
*(Ação no App: Exibir Toast/Dialog alertando que o comprovativo já foi resgatado).*

#### ⏳ 4. SMS Ainda Não Sincronizado (HTTP 404 Not Found)
```json
{
  "sucesso": false,
  "status": "nao_encontrado",
  "mensagem": "❌ Comprovativo não encontrado no sistema. Se você acabou de pagar, aguarde 30 a 60 segundos para o robô sincronizar o SMS e tente novamente."
}
```
*(Ação no App: Pedir para o cliente aguardar 30 segundos e tentar novamente).*

---

## 💎 Fluxo 3: Pagamentos Cripto (Binance Pay - USDT)

### Passo 1: Criar Pedido
Quando o usuário escolhe pagar via Binance Pay:

- **Endpoint**: `POST /api/pagamento/criar`
- **Body**:
```json
{
  "amount": 15.55,
  "currency": "USDT",
  "descricao": "15 Dias VIP",
  "customerInfo": {
    "device_id": "DEV-4A7B8C9D",
    "plano_id": "plano_15d"
  }
}
```
- **Resposta**:
```json
{
  "success": true,
  "data": {
    "codigo": "AVGPT-4KALF9",
    "amount": 15.55,
    "currency": "USDT",
    "instrucao": "Pague 15.5500 USDT via Binance Pay. Após pagar, copie o TXID gerado pela Binance e cole no aplicativo para confirmar."
  }
}
```

### Passo 2: Validar o TXID da Binance
O cliente realiza a transferência na Binance e cola o **TXID**:

- **Endpoint**: `POST /api/pagamento/verificar`
- **Body**:
```json
{
  "codigo": "AVGPT-4KALF9",
  "txid": "9876543210ABCDEF"
}
```
- **Resposta**:
```json
{
  "sucesso": true,
  "status": "paid",
  "mensagem": "✅ Pagamento confirmado! Acesso liberado.",
  "access_token": "a1b2c3d4e5f6...",
  "amount_confirmado": 15.55,
  "user": {
    "device_id": "DEV-4A7B8C9D",
    "status": "ATIVO",
    "plano": "15 Dias VIP",
    "validade_ate": "2026-11-06T19:25:47.890Z"
  }
}
```

---

## 📊 Endpoints de Dados e Configurações

### 1. Listar Planos VIP Disponíveis
- **Endpoint**: `GET /api/planos`
- **Resposta**:
```json
{
  "success": true,
  "count": 4,
  "data": [
    {
      "id": "plano_1d",
      "nome": "1 Dia VIP",
      "dias": 1,
      "preco_mzn": "350.00",
      "preco_usdt": "6.0000",
      "is_popular": false
    },
    {
      "id": "plano_7d",
      "nome": "7 Dias VIP",
      "dias": 7,
      "preco_mzn": "555.00",
      "preco_usdt": "12.2200",
      "is_popular": false
    },
    {
      "id": "plano_15d",
      "nome": "15 Dias VIP",
      "dias": 15,
      "preco_mzn": "799.00",
      "preco_usdt": "15.5500",
      "is_popular": true
    },
    {
      "id": "plano_30d",
      "nome": "30 Dias VIP",
      "dias": 30,
      "preco_mzn": "899.00",
      "preco_usdt": "22.3200",
      "is_popular": false
    }
  ]
}
```

### 2. Listar Casas de Apostas
- **Endpoint**: `GET /api/casas`
- **Resposta**:
```json
{
  "success": true,
  "count": 1,
  "data": [
    {
      "id": "placard_mz",
      "nome": "Placard Moçambique",
      "pais": "Moçambique",
      "link": "https://placard.co.mz",
      "texto_botao": "SINCRONIZAR E JOGAR AGORA",
      "rating": 5,
      "badge": "RECOMENDADA"
    }
  ]
}
```

### 3. Configurações Globais (Suporte / Avisos)
- **Endpoint**: `GET /api/configuracoes`
- **Resposta**:
```json
{
  "success": true,
  "data": {
    "suporte_link": "https://wa.me/258XXXXXXXXX",
    "aviso_admin": "Servidores operando normalmente.",
    "versao_minima": "1.0"
  }
}
```

### 4. Sincronizar Estatísticas de Jogo do Usuário
- **Endpoint**: `POST /api/users/stats`
- **Body**:
```json
{
  "device_id": "DEV-4A7B8C9D",
  "total_vezes_usou_bot": 15,
  "total_lucro": 2450.00,
  "ganhos_hoje": 800.00,
  "perdas_hoje": 120.00
}
```

---

## 🛠️ Exemplo de Implementação em Kotlin (Retrofit)

```kotlin
// ApiService.kt
interface AvgptApi {

    @POST("/api/users/sync")
    suspend fun syncUser(@Body body: Map<String, String>): Response<UserSyncResponse>

    @POST("/api/mobile/resgatar")
    suspend fun resgatarMobileMoney(@Body body: Map<String, String>): Response<ResgateResponse>

    @GET("/api/planos")
    suspend fun getPlanos(): Response<PlanosResponse>

    @GET("/api/casas")
    suspend fun getCasas(): Response<CasasResponse>

    @GET("/api/configuracoes")
    suspend fun getConfiguracoes(): Response<ConfigResponse>
}

// Chamada para resgatar comprovativo (Exemplo):
fun resgatarComprovativo(deviceId: String, textoSms: String) {
    lifecycleScope.launch {
        try {
            val body = mapOf("device_id" to deviceId, "comprovativo" to textoSms)
            val response = api.resgatarMobileMoney(body)

            if (response.isSuccessful) {
                val res = response.body()
                showToast("Licença ativada! Validade: ${res?.validade_ate}")
                abrirRobo()
            } else if (response.code() == 409) {
                showDialog("Erro", "Este comprovativo já foi utilizado!")
            } else if (response.code() == 404) {
                showDialog("Aguarde", "Comprovativo não identificado. Aguarde 30 segundos e tente novamente.")
            }
        } catch (e: Exception) {
            showToast("Erro de rede: ${e.message}")
        }
    }
}
```
