# Railway Deployment – WhatsApp Multi Bot

Bu proje **çoklu WhatsApp oturumu** yönetmek için Railway üzerinde 3 ayrı servis olarak kurgulandı:  

---

## 1. API Servisi
- **Start Command:** `npm run start:api`
- **Görev:**  
  - WhatsApp eventlerini ve API çağrılarını alır.  
  - Webhook teslimatlarını **Redis kuyruğuna** (BullMQ) ekler.  
- **Environment Variables:**  
  - `SUPABASE_URL`  
  - `SUPABASE_SERVICE_KEY`  
  - `REDIS_URL`  
  - `WEBHOOK_QUEUE_NAME=webhooks`  
  - `WEBHOOK_ATTEMPTS=5`  
  - `WEBHOOK_TIMEOUT_MS=10000`  
  - `WEBHOOK_BACKOFF_MS=2000`

---

## 2. Webhook Worker
- **Start Command:** `npm run start:worker`
- **Görev:**  
  - Redis kuyruğundaki işleri tüketir.  
  - Doğru `sessions` kaydını Supabase’ten bulur.  
  - `webhook_url` + `webhook_secret` bilgisiyle POST isteği yapar.  
  - Retry / backoff ile güvenilir teslimat sağlar.  
- **Environment Variables:**  
  - `SUPABASE_URL`  
  - `SUPABASE_SERVICE_KEY`  
  - `REDIS_URL`  
  - `WEBHOOK_QUEUE_NAME=webhooks`

---

## 3. Session Worker (Her WhatsApp Hattı için Ayrı)
- **Start Command:** `npm run start:session`
- **Görev:**  
  - Belirtilen `SESSION_ID`’ye karşılık gelen WhatsApp oturumunu yönetir.  
  - QR → Ready → Disconnected durumlarını Supabase `sessions` tablosuna yazar.  
- **Environment Variables:**  
  - `SESSION_ID=<public.sessions.id>`  
  - `SUPABASE_URL`  
  - `SUPABASE_SERVICE_KEY`  
  - (Opsiyonel) `PUPPETEER_EXECUTABLE_PATH=/usr/bin/chromium`

Yeni bir hat eklemek için Railway’de mevcut session-worker servisini **Duplicate** et → sadece `SESSION_ID` değiştir.  

---

## Redis Servisi
- Railway’de ek Redis servisi açıldı.  
- **Görev:** API (producer) ile Worker (consumer) arasında kuyruğu taşır.  

---

## Notlar
- `postWebhook` artık kullanılmıyor; yerine kuyruğa ekleme var.  
- Reminder özelliği session-worker tarafına taşınmalı (sadece kendi `SESSION_ID` için Supabase’den reminder çekmesi önerilir).  
- LocalAuth volume yerine Supabase DB tabanı kullanılıyorsa `/data` mount edilmesine gerek yok.  

---
