const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

const PROMO_CODES = {
  'ARMFREE10':  10,
  'ARMFREE20':  20,
  'ARMVIP50':   50,
  'FRIEND30':   30,
};

const BASE_PRICE = 1249;

const YUKASSA_SHOP_ID  = process.env.YUKASSA_SHOP_ID;
const YUKASSA_SECRET   = process.env.YUKASSA_SECRET;
const EMAIL_FROM       = process.env.EMAIL_FROM;
const RESEND_API_KEY   = process.env.RESEND_API_KEY;
const SITE_URL         = process.env.SITE_URL || 'http://localhost:3000';

app.get('/api/promo', (req, res) => {
  const code = (req.query.code || '').toUpperCase().trim();
  const discount = PROMO_CODES[code];
  if (!discount) {
    return res.status(404).json({ valid: false, message: 'Промокод не найден' });
  }
  const finalPrice = Math.round(BASE_PRICE * (1 - discount / 100));
  res.json({ valid: true, code, discount, basePrice: BASE_PRICE, finalPrice, saving: BASE_PRICE - finalPrice });
});

app.post('/api/create-payment', async (req, res) => {
  const { email, programId, programTitle, promoCode } = req.body;
  if (!email || !programId) {
    return res.status(400).json({ error: 'Укажите email и programId' });
  }
  let finalPrice = BASE_PRICE;
  let discountApplied = 0;
  if (promoCode) {
    const code = promoCode.toUpperCase().trim();
    const discount = PROMO_CODES[code];
    if (discount) {
      finalPrice = Math.round(BASE_PRICE * (1 - discount / 100));
      discountApplied = discount;
    }
  }
  const idempotenceKey = crypto.randomUUID();
  try {
    const response = await axios.post(
      'https://api.yookassa.ru/v3/payments',
      {
        amount: { value: finalPrice.toFixed(2), currency: 'RUB' },
        confirmation: { type: 'redirect', return_url: `${SITE_URL}/payment-success` },
        capture: true,
        description: `Программа армрестлинга: ${programTitle}`,
        metadata: { email, programId, programTitle, promoCode: promoCode || '', discountApplied },
        receipt: {
          customer: { email },
          items: [{
            description: `Программа армрестлинга: ${programTitle}`,
            quantity: '1',
            amount: { value: finalPrice.toFixed(2), currency: 'RUB' },
            vat_code: 1,
            payment_mode: 'full_payment',
            payment_subject: 'commodity',
          }],
        },
      },
      {
        auth: { username: YUKASSA_SHOP_ID, password: YUKASSA_SECRET },
        headers: { 'Idempotence-Key': idempotenceKey, 'Content-Type': 'application/json' },
      }
    );
    const { id, status, confirmation } = response.data;
    res.json({ paymentId: id, status, confirmationUrl: confirmation.confirmation_url, finalPrice, discountApplied });
  } catch (err) {
    console.error('ЮKassa error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Ошибка создания платежа' });
  }
});

app.post('/api/webhook/yukassa', async (req, res) => {
  const event = req.body;
  if (event.event !== 'payment.succeeded') {
    return res.json({ ok: true });
  }
  const payment = event.object;
  const { email, programId, programTitle } = payment.metadata;
  console.log(`✅ Оплата получена: ${email} — ${programId}`);
  try {
    await sendProgramEmail(email, programId, programTitle);
    console.log(`📧 Письмо отправлено: ${email}`);
  } catch (err) {
    console.error('Ошибка отправки письма:', err.message);
  }
  res.json({ ok: true });
});

async function sendProgramEmail(to, programId, programTitle) {
  const emailHtml = `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; background: #0a0a0c; color: #e8e8e8; padding: 32px; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #e63946, #ff6b35); padding: 3px; border-radius: 12px;">
    <div style="background: #141418; border-radius: 10px; padding: 32px;">
      <h1 style="color: #e63946; font-size: 24px; margin-bottom: 8px;">ALEKSEEV ARMWRESTLING</h1>
      <h2 style="color: #e8e8e8; font-size: 18px; margin-bottom: 24px;">Твоя программа готова! 💪</h2>
      <p style="color: #e8e8e8; line-height: 1.8; margin-bottom: 16px;">Приветствую, воин!</p>
      <p style="color: #9a9aaa; line-height: 1.8; margin-bottom: 16px;">Спасибо за покупку персональной программы тренировок по армрестлингу. Ты получил план, который составлен на основе твоих целей, уровня подготовки и исходных данных. Это не шаблон — нагрузка, упражнения и структура подобраны так, чтобы дать тебе максимальный результат в твоей ситуации.</p>
      <p style="color: #e8e8e8; font-weight: 600; margin-bottom: 8px;">Что внутри программы</p>
      <p style="color: #9a9aaa; line-height: 1.8; margin-bottom: 16px;">У тебя есть четко структурированный план: тренировочные дни, упражнения, подходы и повторения, а также логика прогрессии (повторы в запасе до отказа). Программа сочетает развитие силы, специфики армрестлинга и укрепление ключевых зон — кисти, предплечья, локтя и связок.</p>
      <p style="color: #e8e8e8; font-weight: 600; margin-bottom: 8px;">Как работать по программе:</p>
      <ul style="color: #9a9aaa; line-height: 2; margin-bottom: 16px; padding-left: 20px;">
        <li>Следуй плану без самодеятельности.</li>
        <li>Подбирай рабочие веса так, чтобы последние повторения давались тяжело, но без потери техники.</li>
        <li>Техника всегда важнее веса.</li>
        <li>Не игнорируй восстановление. Сон, питание и отдых — такая же часть прогресса.</li>
        <li>Перед каждой тренировкой обязательно разминайся: кисти, локти, плечи.</li>
        <li>Следи за состоянием локтей и связок. Если появляется боль — снижай нагрузку.</li>
        <li>Делай ставку на регулярность.</li>
        <li>Слушай тело.</li>
      </ul>
      <p style="color: #9a9aaa; line-height: 1.8; margin-bottom: 24px;">Результат здесь не приходит быстро. Ты строишь силу, связки и технику постепенно. Если будешь системно выполнять программу — прогресс будет. Без скачков, но стабильно и надолго.</p>
      <p style="color: #9a9aaa; line-height: 1.8; margin-bottom: 24px;">Если появятся вопросы по программе или технике — можешь написать: тг <a href="https://t.me/idalex" style="color: #e63946;">@idalex</a></p>

      <div style="background: #1c1c22; border-radius: 8px; padding: 16px; margin: 24px 0; border-left: 3px solid #ff6b35;">
        <p style="color: #e8e8e8; font-weight: 600; margin-bottom: 8px;">🎬 Техника упражнений</p>
        <p style="color: #9a9aaa; font-size: 14px; margin-bottom: 12px;">Плейлист с видео по технике выполнения всех упражнений из программы:</p>
        <a href="https://www.youtube.com/watch?v=Uj6OVT0yUgs&list=PLWM4w5Ccz3TGCTklLxL3p507doDRZ52ap" style="display: inline-block; padding: 10px 20px; background: linear-gradient(135deg, #e63946, #ff6b35); color: white; text-decoration: none; border-radius: 6px; font-weight: 600; font-size: 14px;">▶ Смотреть на YouTube</a>
      </div>
      <div style="background: #1c1c22; border-radius: 8px; padding: 16px; margin: 24px 0; border-left: 3px solid #e63946;">
        <strong style="color: #e8e8e8;">Твоя программа:</strong>
        <p style="color: #f4a100; margin: 4px 0 0;">${programTitle}</p>
      </div>
      <p style="color: #9a9aaa; font-size: 14px; margin-bottom: 24px;">Во вложении — полный 8-недельный план тренировок.</p>
      <p style="color: #9a9aaa; line-height: 1.8;">Работай спокойно, системно и с контролем. В армрестлинге выигрывает не тот, кто спешит, а тот, кто стабильно делает работу.</p>
      <p style="color: #e8e8e8; margin-top: 24px; font-weight: 600;">Удачи в тренировках. Ваня Алексеев.</p>
      <hr style="border-color: #2a2a34; margin: 24px 0;">
      <p style="color: #9a9aaa; font-size: 12px; text-align: center;">ALEKSEEV ARMWRESTLING</p>
    </div>
  </div>
</body>
</html>`;

  // Читаем файл программы и конвертируем в base64
  const filePath = path.join(__dirname, 'files', `${programId}.xlsx`);
  const fileContent = fs.readFileSync(filePath).toString('base64');

  // Отправляем через Resend API
  await axios.post(
    'https://api.resend.com/emails',
    {
      from: `Alekseev Armwrestling <${EMAIL_FROM}>`,
      to: [to],
      subject: '💪 Твоя персональная программа по армрестлингу',
      html: emailHtml,
      attachments: [
        {
          filename: `${programId}.xlsx`,
          content: fileContent,
        },
      ],
    },
    {
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

app.get('/api/payment-status/:paymentId', async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.yookassa.ru/v3/payments/${req.params.paymentId}`,
      { auth: { username: YUKASSA_SHOP_ID, password: YUKASSA_SECRET } }
    );
    res.json({ status: response.data.status });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка проверки платежа' });
  }
});

app.listen(4000, () => console.log('🚀 Сервер запущен на порту 4000'));
