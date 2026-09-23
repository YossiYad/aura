# הקמת שרת Cobalt פרטי ל-Aura (חינם, ב-Koyeb)

מדריך זה מקים שרת חילוץ אודיו פרטי משלך, כדי ש-Aura תנגן ללא פרסומות וברקע גם כשהשרתים הציבוריים חסומים. חינם לחלוטין, מתאים ל-10 משתמשים בקלות.

## למה צריך את זה

YouTube חוסם מדי פעם את כל שרתי החילוץ הציבוריים (Piped / Invidious / Cobalt) בבת אחת. שרת פרטי עם IP נקי ונפח נמוך כמעט לא נחסם. Aura תפנה אליו ראשון, ורק אם הוא נופל תיפול לציבוריים.

## שלב 1 - הרשמה ל-Koyeb

1. היכנס ל-https://www.koyeb.com
2. לחץ **Sign up** והתחבר עם GitHub או Google (בלי כרטיס אשראי).

## שלב 2 - יצירת השירות

1. בדשבורד לחץ **Create Service** (או **Create Web Service**).
2. בבחירת המקור בחר **Docker**.
3. בשדה ה-image הדבק:
   ```
   ghcr.io/imputnet/cobalt:10
   ```
4. **Ports / Exposing:** ודא שה-port הוא **9000** (ברירת המחדל של Cobalt). אם יש שדה health check path, השאר `/`.
5. **Instance type:** בחר את התוכנית החינמית (**Free** / **Eco** / nano - הכי קטנה).
6. **Region:** בחר את הקרוב אליך (Frankfurt / Washington).

## שלב 3 - משתני סביבה (Environment variables)

הוסף את המשתנים הבאים (Add variable):

| Key | Value |
|-----|-------|
| `API_URL` | `https://<APP-NAME>-<ORG>.koyeb.app/` |
| `API_PORT` | `9000` |

- את `API_URL` תדע רק אחרי שהשירות נוצר וקיבל URL. אפשר:
  1. ליצור קודם עם ערך זמני, לראות את ה-URL שקיבלת, ואז לערוך את `API_URL` לערך הנכון ולעשות redeploy. **חובה** ש-`API_URL` יהיה בדיוק ה-URL הציבורי של השירות עם `/` בסוף - אחרת ה-tunnel לא יעבוד.

## שלב 4 - Deploy

1. לחץ **Deploy**.
2. חכה 1-3 דקות עד שהסטטוס **Healthy** (ירוק).
3. פתח בדפדפן את ה-URL שקיבלת (למשל `https://your-app-your-org.koyeb.app/`). אם תראה JSON עם `"cobalt"` ו-`"version"` - השרת עובד.

## שלב 5 - חיבור ל-Aura

1. פתח את Aura, לך ל-**הגדרות** (אייקון גלגל שיניים).
2. בשדה **"Your private Cobalt server"** הדבק את ה-URL המלא (עם `/` בסוף):
   ```
   https://your-app-your-org.koyeb.app/
   ```
3. לחץ **Save**.
4. נגן שיר. פתח **Show logs** - אתה אמור לראות `[cobalt] stream OK via <השרת שלך>` ושהניגון מגיע ממנו.

## אם YouTube חוסם את השרת שלך (נדיר)

אם אחרי כמה שבועות מתחילות שגיאות `youtube.login`:

1. ב-Koyeb, ערוך את השירות והוסף משתנה סביבה `COOKIE_PATH` עם קובץ cookies של YouTube (מיוצא עם תוסף "Get cookies.txt"). זה מחזיר את השרת לעבוד.
2. פירוט מלא: https://github.com/imputnet/cobalt/blob/main/docs/run-an-instance.md

## עלות

$0. התוכנית החינמית של Koyeb מספיקה ל-10 משתמשים. השירות עשוי להירדם אחרי חוסר פעילות ממושך - הבקשה הראשונה אחרי שינה תהיה איטית (~30 שניות), אחר כך מהיר.
