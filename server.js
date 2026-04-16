const express = require('express');
const cors = require('cors');
const crypto = require('crypto');
const axios = require('axios');
const nodemailer = require('nodemailer');
const path = require('path');
require('dotenv').config();

const app = express();
app.use(cors());
app.use(express.json());

// ─────────────────────────────────────────────
//  ПРОМОКОДЫ — добавляйте/удаляйте здесь
//  Формат: 'КОД': процент_скидки
// ─────────────────────────────────────────────
const PROMO_CODES = {
  'ARMFREE10':  10,   // скидка 10%
  'ARMFREE20':  20,   // скидка 20%
  'ARMVIP50':   50,   // скидка 50%
  'FRIEND30':   30,   // скидка 30%
  // Добавляйте новые промокоды сюда:
  // 'ВАШ_КОД': процент,
};

const BASE_PRICE = 1249; // рублей

// ─────────────────────────────────────────────
//  КОНФИГИ (заполняются через .env)
// ─────────────────────────────────────────────
const YUKASSA_SHOP_ID  = process.env.YUKASSA_SHOP_ID;   // из личного кабинета ЮKassa
const YUKASSA_SECRET   = process.env.YUKASSA_SECRET;    // секретный ключ ЮKassa
const EMAIL_FROM       = process.env.EMAIL_FROM;        // ВАШ email (отправитель)
const EMAIL_PASSWORD   = process.env.EMAIL_PASSWORD;    // пароль приложения Gmail
const SITE_URL         = process.env.SITE_URL || 'http://localhost:3000';

// ─────────────────────────────────────────────
//  Nodemailer (Gmail SMTP)
// ─────────────────────────────────────────────
const transporter = nodemailer.createTransport({
  service: 'gmail',
  auth: {
    user: EMAIL_FROM,
    pass: EMAIL_PASSWORD, // App Password из Google Account
  },
});

// ─────────────────────────────────────────────
//  1. Проверка промокода
//  GET /api/promo?code=ARMFREE20
// ─────────────────────────────────────────────
app.get('/api/promo', (req, res) => {
  const code = (req.query.code || '').toUpperCase().trim();
  const discount = PROMO_CODES[code];

  if (!discount) {
    return res.status(404).json({ valid: false, message: 'Промокод не найден' });
  }

  const finalPrice = Math.round(BASE_PRICE * (1 - discount / 100));
  res.json({
    valid: true,
    code,
    discount,        // % скидки
    basePrice: BASE_PRICE,
    finalPrice,      // итоговая цена в рублях
    saving: BASE_PRICE - finalPrice,
  });
});

// ─────────────────────────────────────────────
//  2. Создание платежа в ЮKassa
//  POST /api/create-payment
//  Body: { email, programId, programTitle, promoCode? }
// ─────────────────────────────────────────────
app.post('/api/create-payment', async (req, res) => {
  const { email, programId, programTitle, promoCode } = req.body;

  if (!email || !programId) {
    return res.status(400).json({ error: 'Укажите email и programId' });
  }

  // Считаем финальную цену с промокодом
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
        amount: {
          value: finalPrice.toFixed(2),
          currency: 'RUB',
        },
        confirmation: {
          type: 'redirect',
          return_url: `${SITE_URL}/payment-success`,
        },
        capture: true,
        description: `Программа армрестлинга: ${programTitle}`,
        metadata: {
          email,
          programId,
          programTitle,
          promoCode: promoCode || '',
          discountApplied,
        },
        receipt: {
          customer: { email },
          items: [{
            description: `Программа армрестлинга: ${programTitle}`,
            quantity: '1',
            amount: { value: finalPrice.toFixed(2), currency: 'RUB' },
            vat_code: 1, // без НДС
            payment_mode: 'full_payment',
            payment_subject: 'commodity',
          }],
        },
      },
      {
        auth: {
          username: YUKASSA_SHOP_ID,
          password: YUKASSA_SECRET,
        },
        headers: {
          'Idempotence-Key': idempotenceKey,
          'Content-Type': 'application/json',
        },
      }
    );

    const { id, status, confirmation } = response.data;
    res.json({
      paymentId: id,
      status,
      confirmationUrl: confirmation.confirmation_url, // редирект на страницу оплаты ЮKassa
      finalPrice,
      discountApplied,
    });

  } catch (err) {
    console.error('ЮKassa error:', err.response?.data || err.message);
    res.status(500).json({ error: 'Ошибка создания платежа' });
  }
});

// ─────────────────────────────────────────────
//  3. Webhook от ЮKassa (автоматически при оплате)
//  POST /api/webhook/yukassa
// ─────────────────────────────────────────────
app.post('/api/webhook/yukassa', async (req, res) => {
  const event = req.body;

  // Проверяем что платёж успешен
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
    // Возвращаем 200 чтобы ЮKassa не повторяла webhook
  }

  res.json({ ok: true });
});

// ─────────────────────────────────────────────
//  4. Функция отправки письма с программой
// ─────────────────────────────────────────────
async function sendProgramEmail(to, programId, programTitle) {
  // ────────────────────────────────────────────
  //  ТЕКСТ ПИСЬМА — замените на ваш текст
  // ────────────────────────────────────────────
  const emailText = `
Приветствую, воин!

Спасибо за покупку персональной программы тренировок по армрестлингу. Ты получил план, который составлен на основе твоих целей, уровня подготовки и исходных данных. Это не шаблон — нагрузка, упражнения и структура подобраны так, чтобы дать тебе максимальный результат в твоей ситуации.

Что внутри программы
У тебя есть четко структурированный план: тренировочные дни, упражнения, подходы и повторения, а также логика прогрессии (повторы в запасе до отказа). Программа сочетает развитие силы, специфики армрестлинга и укрепление ключевых зон — кисти, предплечья, локтя и связок. Все сделано так, чтобы ты просто открывал план и понимал, что делать на каждой тренировке.

Как работать по программе:
Следуй плану без самодеятельности. Частота тренировок уже рассчитана — не нужно добавлять «от себя» лишние нагрузки, это чаще тормозит прогресс, чем ускоряет его.

Подбирай рабочие веса так, чтобы последние повторения давались тяжело, исходя из пункта «повторы в запасе», но без потери техники. Если становится легко — постепенно увеличивай нагрузку. Если чувствуешь нестабильность или дискомфорт в суставах — снижай вес и усиливай контроль.

Техника всегда важнее веса. Неправильное выполнение не только снижает эффективность, но и увеличивает риск травм, особенно в локте и запястье.

Не игнорируй восстановление. Сон, питание и отдых между тренировками — это такая же часть прогресса, как и сами тренировки.

Перед каждой тренировкой обязательно разминайся: кисти, локти, плечи. Это снизит риск травм и повысит качество работы.

Следи за состоянием локтей и связок. В армрестлинге это слабое место. Если появляется боль — это сигнал снизить нагрузку, а не терпеть.

Делай ставку на регулярность. Лучше стабильно идти по плану, чем периодически перегружаться и откатываться назад.

Слушай тело. Прогресс — это баланс между нагрузкой и восстановлением, а не постоянная работа на пределе.

Немного про настрой:
Результат здесь не приходит быстро. Ты строишь силу, связки и технику постепенно. Если будешь системно выполнять программу и не выпадать из процесса — прогресс будет. Без скачков, но стабильно и надолго.

Если появятся вопросы по программе или технике — можешь написать: тг @idalex.

Рекомендую также фиксировать результаты: рабочие веса, самочувствие, ключевые упражнения. Это поможет видеть реальную динамику и понимать, что работает лучше всего.

Работай спокойно, системно и с контролем. В армрестлинге выигрывает не тот, кто спешит, а тот, кто стабильно делает работу.

Удачи в тренировках. Ваня Алексеев.
Твоя программа: ${programTitle}

  `.trim();

  const emailHtml = `
<!DOCTYPE html>
<html>
<body style="font-family: Arial, sans-serif; background: #0a0a0c; color: #e8e8e8; padding: 32px; max-width: 600px; margin: 0 auto;">
  <div style="background: linear-gradient(135deg, #e63946, #ff6b35); padding: 3px; border-radius: 12px;">
    <div style="background: #141418; border-radius: 10px; padding: 32px;">
      <h1 style="color: #e63946; font-size: 24px; margin-bottom: 8px;">ARMWRESTLING PRO</h1>
      <h2 style="color: #e8e8e8; font-size: 18px; margin-bottom: 24px;">Твоя программа готова! 💪</h2>
      
      <!-- ВСТАВЬТЕ ВАШ ТЕКСТ СЮДА -->
      <p style="color: #9a9aaa; line-height: 1.6; margin-bottom: 16px;">
        Приветствую, воин!

Спасибо за покупку персональной программы тренировок по армрестлингу. Ты получил план, который составлен на основе твоих целей, уровня подготовки и исходных данных. Это не шаблон — нагрузка, упражнения и структура подобраны так, чтобы дать тебе максимальный результат в твоей ситуации.

Что внутри программы
У тебя есть четко структурированный план: тренировочные дни, упражнения, подходы и повторения, а также логика прогрессии (повторы в запасе до отказа). Программа сочетает развитие силы, специфики армрестлинга и укрепление ключевых зон — кисти, предплечья, локтя и связок. Все сделано так, чтобы ты просто открывал план и понимал, что делать на каждой тренировке.

Как работать по программе:
Следуй плану без самодеятельности. Частота тренировок уже рассчитана — не нужно добавлять «от себя» лишние нагрузки, это чаще тормозит прогресс, чем ускоряет его.

Подбирай рабочие веса так, чтобы последние повторения давались тяжело, исходя из пункта «повторы в запасе», но без потери техники. Если становится легко — постепенно увеличивай нагрузку. Если чувствуешь нестабильность или дискомфорт в суставах — снижай вес и усиливай контроль.

Техника всегда важнее веса. Неправильное выполнение не только снижает эффективность, но и увеличивает риск травм, особенно в локте и запястье.

Не игнорируй восстановление. Сон, питание и отдых между тренировками — это такая же часть прогресса, как и сами тренировки.

Перед каждой тренировкой обязательно разминайся: кисти, локти, плечи. Это снизит риск травм и повысит качество работы.

Следи за состоянием локтей и связок. В армрестлинге это слабое место. Если появляется боль — это сигнал снизить нагрузку, а не терпеть.

Делай ставку на регулярность. Лучше стабильно идти по плану, чем периодически перегружаться и откатываться назад.

Слушай тело. Прогресс — это баланс между нагрузкой и восстановлением, а не постоянная работа на пределе.

Немного про настрой:
Результат здесь не приходит быстро. Ты строишь силу, связки и технику постепенно. Если будешь системно выполнять программу и не выпадать из процесса — прогресс будет. Без скачков, но стабильно и надолго.

Если появятся вопросы по программе или технике — можешь написать: тг @idalex.

Рекомендую также фиксировать результаты: рабочие веса, самочувствие, ключевые упражнения. Это поможет видеть реальную динамику и понимать, что работает лучше всего.

Работай спокойно, системно и с контролем. В армрестлинге выигрывает не тот, кто спешит, а тот, кто стабильно делает работу.

Удачи в тренировках. Ваня Алексеев.
Твоя программа: ${programTitle}
      </p>
      
      <div style="background: #1c1c22; border-radius: 8px; padding: 16px; margin: 24px 0; border-left: 3px solid #e63946;">
        <strong style="color: #e8e8e8;">Программа:</strong>
        <p style="color: #f4a100; margin: 4px 0 0;">${programTitle}</p>
      </div>
      
      <p style="color: #9a9aaa; font-size: 14px;">Во вложении — полный 8-недельный план тренировок.</p>
      
      <hr style="border-color: #2a2a34; margin: 24px 0;">
      <p style="color: #9a9aaa; font-size: 12px; text-align: center;">ArmWrestling Pro</p>
    </div>
  </div>
</body>
</html>
  `;

  await transporter.sendMail({
    from: `"ArmWrestling Pro" <${EMAIL_FROM}>`,
    to,
    subject: '🏆 Твоя программа тренировок по армрестлингу',
    text: emailText,
    html: emailHtml,
    attachments: [
      {
        // ────────────────────────────────────────
        //  ФАЙЛ ПРОГРАММЫ — замените путь на ваш
        //  Например: './files/program.xlsx'
        // ────────────────────────────────────────
        filename: 'armwrestling-program.xlsx', // имя файла для получателя
        path: path.join(__dirname, 'files', `${programId}.xlsx`), // ПУТЬ К ВАШЕМУ ФАЙЛУ
      },
    ],
  });
}

// ─────────────────────────────────────────────
//  5. Проверка статуса платежа (для фронтенда)
//  GET /api/payment-status/:paymentId
// ─────────────────────────────────────────────
app.get('/api/payment-status/:paymentId', async (req, res) => {
  try {
    const response = await axios.get(
      `https://api.yookassa.ru/v3/payments/${req.params.paymentId}`,
      {
        auth: {
          username: YUKASSA_SHOP_ID,
          password: YUKASSA_SECRET,
        },
      }
    );
    res.json({ status: response.data.status });
  } catch (err) {
    res.status(500).json({ error: 'Ошибка проверки платежа' });
  }
});

app.listen(4000, () => console.log('🚀 Сервер запущен на порту 4000'));
