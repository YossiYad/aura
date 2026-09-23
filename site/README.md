# Aura landing page

The public project website lives here. It presents Aura's features, screenshots and
installation guides. It does not run the music player or require a music backend.

## Preview locally

From the repository root, with Node.js 22+ and Python 3 installed:

```sh
node scripts/build-landing.cjs
python3 -m http.server 8490 --directory .local/landing
```

Open `http://localhost:8490`. The build copies only the three site files, the app icon
and the three approved screenshots into `.local/landing`. The phone screenshot is
the supplied original; the other screenshots use fictional demo data.

## GitHub Pages

Set **Settings > Pages > Build and deployment > Source** to **GitHub Actions**.
The `Landing page` workflow publishes `.local/landing` when website files change on
`main`, or when manually dispatched. The expected project URL is
`https://YossiYad.github.io/aura/`. Relative asset paths work at this project subpath.

Pages availability for private repositories depends on the account's GitHub plan.
The landing page is intended to be public, and its installation and source links
require visitors to have access to the application repository.

The app's root `index.html`, service worker, private configuration and server files
are not part of the Pages artifact. The site does not load third-party fonts, scripts
or analytics. GitHub's hosting service still has its own
[request logging policies](https://docs.github.com/en/pages/getting-started-with-github-pages/what-is-github-pages#data-collection).

## Design references

The layout was informed by these open-source project sites:

- [OBS](https://obsproject.com/): a clear product introduction and prominent setup action.
- [Jellyfin](https://jellyfin.org/): device support, self-hosting context and product screenshots.
- [FreeTube](https://freetubeapp.io/): concise feature explanations and platform guidance.
- [Kdenlive](https://kdenlive.org/): feature storytelling and contribution paths.
- [Audacity](https://www.audacityteam.org/): a product-led introduction and practical FAQ.

The page uses original markup, styling and copy, with Aura's own screenshots.
