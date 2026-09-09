# مكتب رصد العمداء

نظام المرحلة الأولى لرصد 12 عمدة مختارين، ثم مراجعة الموظف للوارد والمستبعد.

## ماذا يفعل؟

- **بحث يدوي:** لا يعمل إلا بعد ضغط زر «بحث»
- **رصد مجدول:** كل أحد الساعة 06:00 بتوقيت الرياض
- **مفاتيح الرصد:** الاسم الإنجليزي + لغة أم الدولة
- **العربي:** لغة صفحة الموظف، والاسم العربي للعرض النهائي فقط
- **المصادر:** Google News + Bing News + GDELT + النطاقات الرسمية + Inoreader عند ربطه
- **النشرة:** يُقرأ جسم المقال المنظف (حتى 80 ألف حرف لكل مصدر)، وتُدمج صفحات الحدث، ثم يلخصها Gemini
- **التدقيق:** يراجع Gemini كل ادعاء في مرور مستقل، ولا يُقبل دون اقتباس حرفي من المصدر
- **الجدولة:** يوزع Queue رصد الأحد إلى مهمة مستقلة لكل مكتب حتى لا تسقط الدفعة كلها

## التشغيل المحلي

```bash
npm install
npm test
npm run dev
```

ثم افتح `http://127.0.0.1:8787`

## المفاتيح

لا تضع المفاتيح في الشات. انسخ `.dev.vars.example` إلى `.dev.vars`.

```
GEMINI_API_KEY=
GEMINI_MODEL=gemini-3.8-flash
INOREADER_APP_ID=
INOREADER_APP_KEY=
INOREADER_ACCESS_TOKEN=
```

محليًا يوضع مفتاح Gemini في `.dev.vars`. في Cloudflare يوضع كمتغير سرّي:

```bash
npx wrangler secret put GEMINI_API_KEY
npx wrangler secret put DASHBOARD_PASSWORD
```

Google News وBing News وGDELT لا تحتاج مفاتيح. إذا لم يوجد مفتاح Gemini يبقى الملخص
في حالة «بانتظار AI» بدل نشر ملخص آلي غير موثوق.

قبل أول نشر أنشئ طابور Cloudflare المعرّف في `wrangler.toml`:

```bash
npx wrangler queues create mayor-watch-scans
```

عند ضبط `DASHBOARD_PASSWORD` يحمي Worker الصفحة وكل واجهات التعديل بمصادقة المتصفح
الأساسية. اسم المستخدم الافتراضي `mayorwatch` ويمكن تغييره عبر `DASHBOARD_USER`.
يمكن وضع Cloudflare Access أمامها كطبقة إضافية في النشر المؤسسي.

حماية الصفحة إلزامية عند وجود `GEMINI_API_KEY`: إذا ضُبط مفتاح Gemini دون
`DASHBOARD_PASSWORD` يرفض Worker طلبات الويب حتى لا تصبح التكلفة وقرارات الاعتماد عامة.

## الجدول

Cron على Cloudflare: `0 3 * * 0` = الأحد 03:00 UTC = الأحد 06:00 في الرياض.
