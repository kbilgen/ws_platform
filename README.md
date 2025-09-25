# WhatsApp Railway Bot (whatsapp-web.js)

Node.js + whatsapp-web.js ile **API** ve **Webhook** destekli WhatsApp botu. Railway için Dockerfile hazırdır.

## Kurulum

```bash
npm ci
# local:
cp .env.example .env
npm run start
# ws_platform

WhatsApp Multi-Session Bot – Kullanım Dokümantasyonu
1. Genel Mimari

Backend: Node.js + Express + whatsapp-web.js

Depolama: SQLite (/data/app.sqlite) + LocalAuth session klasörleri (/data/sessions)

Deploy: Railway (otomatik rehydrate ile pod restart sonrası session’lar geri yüklenir)

Güvenlik:

Admin paneli: X-Admin-Auth (base64(admin:admin))

API: Her session için ayrı API Key

Webhook: Her session için ayrı Webhook Secret (HMAC-SHA256 doğrulaması)

2. Giriş & Admin Paneli

URL: https://<your-app>.up.railway.app/admin.html

Default admin: admin / admin

Panelden yapabileceklerin:

Yeni session oluştur (QR + API Key + Webhook Secret otomatik üretilir)

QR kodunu gösterip telefonla tarat

Webhook URL kaydet

Canlı mesaj akışını izle (SSE)

Session durumlarını ve anahtarlarını görüntüle

3. Session Yaşam Döngüsü

Oluşturma
POST /admin/sessions → yeni session kaydı + API Key + Secret üretir.

QR ile eşleme
GET /admin/sessions/:id/qr → QR kodu dönene kadar periyodik bakılır.

Ready olduğunda → status=ready, mesaj gönderilebilir.

Webhook ayarı
POST /admin/sessions/:id/webhook → webhook URL kaydedilir.

Kopma olursa → client otomatik reconnect dener.

Restart gerekirse → POST /admin/sessions/:id/restart

4. Tenant API (Müşteri Kullanımı)
4.1 Metin Gönder
POST /api/:sessionId/send-text
Headers:
  X-API-Key: <session_api_key>
Body:
{
  "to": "9053XXXXXXXX",
  "text": "Merhaba! ✅"
}


Yanıt:

{ "ok": true, "id": "wamid.HBg..." }

4.2 Medya Gönder
POST /api/:sessionId/send-media
Headers:
  X-API-Key: <session_api_key>
Body:
{
  "to": "9053XXXXXXXX",
  "caption": "Fotoğraf",
  "media": {
    "base64": "<BASE64_STRING>",
    "filename": "resim.jpg",
    "mime": "image/jpeg"
  }
}

5. Webhook Entegrasyonu
5.1 Kurulum

Admin panelden session seç → Webhook URL alanına kendi backend adresini gir.

Bot artık her gelen olay için POST yapar.

5.2 Payload Örnekleri
Mesaj
{
  "sessionId": "ws_mfzkpq0s",
  "event": "message",
  "data": {
    "from": "9053XXXX@c.us",
    "to": "9053YYYY@c.us",
    "body": "Merhaba",
    "isGroup": false,
    "timestamp": 1758800000
  },
  "ts": 1758800123456
}

Ready
{ "sessionId":"ws_mfzkpq0s","event":"ready","data":{},"ts":1758800123456 }

Disconnected
{
  "sessionId":"ws_mfzkpq0s",
  "event":"disconnected",
  "data": { "reason": "NAVIGATION" },
  "ts": 1758800123456
}

5.3 İmza Doğrulama

Header: X-Signature

HMAC-SHA256(JSON.stringify(body), WEBHOOK_SECRET)

6. Admin Endpointleri
Endpoint	Method	Açıklama
/admin/login	POST	{username,password} → auth
/admin/sessions	GET	Tüm session listesi
/admin/sessions	POST	Yeni session oluştur
/admin/sessions/:id/qr	GET	QR kodu veya ready durumu
/admin/sessions/:id/webhook	POST	Webhook URL kaydet
/admin/sessions/:id/status	GET	DB ve RAM durumu
/admin/sessions/:id/restart	POST	Session yeniden başlat
/admin/sessions/:id	DELETE	Session sil

Header: X-Admin-Auth: base64("admin:admin")

7. Sağlık & Monitoring

/health → { ok:true, sessions:<dbCount>, live:<inMemoryCount> }

Railway logs → hata takibi için bak.

Admin panel → canlı SSE feed ile gelen mesaj ve durumları izle.

8. Best Practices

API Key & Webhook Secret’ları gizli tut. Rotate etmek için DB’den silebilirsin → yeni key üret.

Rate limiting eklemek için Express middleware kullanabilirsin.

Webhook retry için gönderim hatalarında kuyruk (Redis, SQS) kullanman önerilir.

Session Volume (/data) Railway’de persistent volume olmalı. Yoksa pod restartında session kaybolur.

9. Örnek Çalışma Akışı

Admin panelden yeni session oluştur → API Key + Secret al.

QR göster → telefondan tara.

/health → live:1 döndüğünü kontrol et.

Webhook URL’ini gir.

Artık cURL veya Postman ile mesaj gönder → webhook listener’da gelen event’i gör.