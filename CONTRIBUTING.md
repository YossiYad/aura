# Contributing to Aura

Bug reports, documentation improvements and code contributions are welcome. For a large
change, open an issue first to discuss the intended behavior.

## Run locally

Use Python 3 to serve the static client, and Node.js 22 or newer to run the tests:

```sh
git clone https://github.com/YossiYad/aura.git
cd aura
python3 -m http.server 8477
```

Open <http://localhost:8477>. No build or frontend package installation is required.
Optional backend services have their own dependencies and setup instructions under
[`selfhost/`](selfhost/private-app/README.md). Configure your own instances in the
git-ignored `config.json`, using `config.example.json` as a starting point.

## Make a change

- Keep changes focused and describe the user-visible problem and resulting behavior.
- Follow the existing vanilla JavaScript modules. `Store` owns persisted client state.
- For client changes, increase the cache number in `sw.js` and `APP_VERSION` in
  `src/views.js` together so installed apps receive the update. Documentation and test-only
  changes do not need a version bump.
- A module can be split into smaller files under a folder of its name (`src/views/home.js`
  beside `src/views.js`). Each file stays a plain script with its top-level functions
  indented two spaces, as today. List it in `index.html` in load order and in `SHELL` in
  `sw.js`; tests fail if either is missing. The tests read a module as all of its files in
  that order (`tests/source.js`), so they keep working when code moves between them.
- The files of one module reach each other through its internal namespace, `V`
  (`window.Aura.views`, `.player`, `.api`, `.main`, `.store`, `.orbs`, `.sync` and
  `.voice`): a file publishes the names other files use at its top, and calls them as
  `V.render()`. Code that runs while a file loads, including any function it calls on the
  way, can only use files loaded before it; a function declaration can move to an earlier
  file to make that so. The header of each module's first file (`src/views.js`,
  `src/player.js`, `src/api.js`, `src/main.js`, `src/store.js`, `src/sync.js`,
  `src/voice.js`) has the details.
- Third-party code lives in `src/vendor/`, kept exactly as upstream publishes it and listed
  in `THIRD-PARTY-NOTICES.md`; VS Code opens it read-only (`.vscode/settings.json`).
  Change the code of ours that wraps it instead, such as the `<thinking-orb>` element in
  `src/orbs.js` around `src/vendor/thinking-orbs.js`.
- Add regression coverage for behavior changes. Use invented fixtures and example
  addresses instead of personal data, credentials or copied lyrics.
- Keep private configuration, cookies, logs and downloaded media out of commits.

## Check your work

```sh
npm ci --prefix selfhost/private-app/queue
node --test tests/*.test.js
npx --package typescript@5.9.3 tsc -p jsconfig.json
git diff --check
```

The unit and integration suite uses Node's test runner. The first line installs the shared
queue server's one dependency, which its tests load; it is needed once. The `tsc` line
checks the JSDoc types across `src/` without building anything; VS Code shows the same
errors as you type. Browser scripts under `tests/` are separate checks and require
Playwright. Relevant phone, audio interruption, AirPlay and Cast changes also need
real-device validation; report what you could and could not verify in the pull request.

Open a pull request against `main`, describing the change and the checks you ran. Include
screenshots for visible UI changes. Report security vulnerabilities privately using
[`SECURITY.md`](SECURITY.md).

## License

By contributing, you agree that your contributions are provided under **AGPL-3.0-only**,
the project's license. Preserve existing copyright and license notices, and document
any new third-party material in [`THIRD-PARTY-NOTICES.md`](THIRD-PARTY-NOTICES.md).
