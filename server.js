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
app.use(express.urlencoded({ extended: true }));

const PROMO_CODES = {
  'ARMFREE10':  10,
  'ARMFREE20':  20,
  'ARMVIP50':   50,
  'FRIEND30':   30,
};

const BASE_PRICE = 1249;

const ROBOKASSA_LOGIN = process.env.ROBOKASSA_LOGIN;
const ROBOKASSA_PASS1 = process.env.ROBOKASSA_PASS1;
const ROBOKASSA_PASS2 = process.env.ROBOKASSA_PASS2;
const EMAIL_FROM      = process.env.EMAIL_FROM;
const RESEND_API_KEY  = process.env.RESEND_API_KEY;
const SITE_URL        = process.env.SITE_URL || 'http://localhost:3000';

// Хранилище платежей в памяти
const pendingPayments = {};

function md5(str) {
  return crypto.createHash('md5').update(str).digest('hex');
}

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

  const invId = Date.now();
  const amount = finalPrice.toFixed(2);
  const description = `Программа армрестлинга: ${programTitle}`;

  // Сохраняем данные заказа
  pendingPayments[invId] = { email, programId, programTitle, discountApplied };

  // Подпись: MD5(login:amount:invId:pass1)
  const signature = md5(`${ROBOKASSA_LOGIN}:${amount}:${invId}:${ROBOKASSA_PASS1}`);

  const params = new URLSearchParams({
    MerchantLogin: ROBOKASSA_LOGIN,
    OutSum: amount,
    InvId: invId,
    Description: description,
    SignatureValue: signature,
    Email: email,
    IsTest: 0,
    Culture: 'ru',
    Encoding: 'utf-8',
  });

  const confirmationUrl = `https://auth.robokassa.ru/Merchant/Index.aspx?${params.toString()}`;

  res.json({ paymentId: invId, status: 'pending', confirmationUrl, finalPrice, discountApplied });
});

// Webhook от Робокассы (ResultURL)
app.post('/api/webhook/robokassa', async (req, res) => {
  const { OutSum, InvId, SignatureValue } = req.body;

  // Проверка подписи: MD5(outSum:invId:pass2)
  const expectedSig = md5(`${OutSum}:${InvId}:${ROBOKASSA_PASS2}`).toUpperCase();
  const receivedSig = (SignatureValue || '').toUpperCase();

  if (expectedSig !== receivedSig) {
    console.error(`❌ Неверная подпись webhook`);
    return res.status(400).send('bad signature');
  }

  const payment = pendingPayments[InvId];
  if (!payment) {
    console.error(`❌ Платёж не найден: InvId=${InvId}`);
    return res.send(`OK${InvId}`);
  }

  const { email, programId, programTitle } = payment;
  console.log(`✅ Оплата получена: ${email} — ${programId}`);

  try {
    await sendProgramEmail(email, programId, programTitle);
    console.log(`📧 Письмо отправлено: ${email}`);
    delete pendingPayments[InvId];
  } catch (err) {
    console.error('Ошибка отправки письма:', err.message);
  }

  res.send(`OK${InvId}`);
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

  const filePath = path.join(__dirname, 'files', `${programId}.xlsx`);
  const fileContent = fs.readFileSync(filePath).toString('base64');

  await axios.post(
    'https://api.resend.com/emails',
    {
      from: `Alekseev Armwrestling <${EMAIL_FROM}>`,
      to: [to],
      subject: '💪 Твоя персональная программа по армрестлингу',
      html: emailHtml,
      attachments: [{ filename: `${programId}.xlsx`, content: fileContent }],
    },
    {
      headers: {
        'Authorization': `Bearer ${RESEND_API_KEY}`,
        'Content-Type': 'application/json',
      },
    }
  );
}

app.listen(4000, () => console.log('🚀 Сервер запущен на порту 4000'));
