# הקמת שרת Cobalt פרטי ל-Aura (חינם, בלי כרטיס אשראי) - Hugging Face Spaces

Koyeb התחילו לדרוש כרטיס אשראי. **Hugging Face Spaces** חינם לגמרי, בלי כרטיס אשראי, ומריץ Docker. זו הדרך המומלצת עכשיו.

## שלב 1 - הרשמה

1. היכנס ל-https://huggingface.co/join
2. הירשם עם אימייל או GitHub. אין צורך בכרטיס אשראי.
3. אמת את האימייל.

## שלב 2 - יצירת Space

1. לך ל-https://huggingface.co/new-space
2. **Space name:** `aura-cobalt` (או כל שם).
3. **License:** אפשר להשאיר ריק / mit.
4. **Select the SDK:** בחר **Docker** → ואז **Blank** (תבנית ריקה).
5. **Hardware:** השאר **CPU basic - free**.
6. **Visibility:** Public (חינם; Private דורש הגדרה נוספת).
7. לחץ **Create Space**.

## שלב 3 - העלאת שני קבצים

ב-Space החדש, לשונית **Files** → **Add file** → **Create a new file**. צור שני קבצים:

### קובץ 1: `Dockerfile`
```
FROM ghcr.io/imputnet/cobalt:10

ENV API_PORT=7860
ENV API_LISTEN_ADDRESS=0.0.0.0

EXPOSE 7860
```

### קובץ 2: `README.md`
```
---
title: Aura Cobalt
emoji: 🎵
colorFrom: green
colorTo: gray
sdk: docker
app_port: 7860
pinned: false
---

Private Cobalt instance for Aura.
```

(שני הקבצים כבר מוכנים ב-repo תחת `deploy/cobalt-hf/` - אפשר פשוט להעתיק משם.)

## שלב 4 - הגדרת API_URL

1. אחרי יצירת הקבצים, ה-Space יתחיל לבנות (Building). חכה שיעלה.
2. ה-URL הציבורי של ה-Space הוא בפורמט: `https://<USERNAME>-aura-cobalt.hf.space`
   (רואים אותו בכפתור **⋮** → **Embed this Space**, או פשוט מרכיבים: שם-משתמש + מקף + שם-Space).
3. לך ל-**Settings** של ה-Space → **Variables and secrets** → **New variable**:
   - **Name:** `API_URL`
   - **Value:** ה-URL המלא עם `/` בסוף, למשל `https://your-name-aura-cobalt.hf.space/`
4. **Restart** ל-Space (Settings → Factory reboot / Restart).

**קריטי:** `API_URL` חייב להיות בדיוק ה-URL הציבורי עם `/` בסוף, אחרת ה-tunnel לא יעבוד.

## שלב 5 - בדיקה

פתח בדפדפן: `https://<USERNAME>-aura-cobalt.hf.space/`
אם רואה JSON עם `"cobalt"` ו-`"version"` - השרת עובד.

## שלב 6 - חיבור ל-Aura

1. Aura → **הגדרות** → שדה **"Your private Cobalt server"**.
2. הדבק את ה-URL עם `/` בסוף.
3. **Save**, נגן שיר, פתח **Show logs** - אמור להופיע `[cobalt] stream OK via <ה-Space שלך>`.

## הערות

- **חינם לגמרי, בלי כרטיס.** מתאים ל-10 משתמשים.
- Space חינמי נרדם אחרי ~48 שעות חוסר פעילות. הבקשה הראשונה אחרי שינה איטית (~30ש'), אחר כך מהיר.
- אם YouTube חוסם אחרי כמה שבועות (`youtube.login`): הוסף cookies של YouTube דרך משתנה סביבה, פירוט: https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md

## חלופה בלי כרטיס: Render

גם https://render.com מציע web service חינמי בלי כרטיס אשראי. שם צריך repo עם ה-Dockerfile (אפשר לפצל את `deploy/cobalt-hf/` לריפו נפרד ולחבר). Hugging Face פשוט יותר, לכן הוא המומלץ.
