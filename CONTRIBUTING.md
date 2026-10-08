# Contributing to Roku TV Parental Control

Thanks for helping. Most contributions don't need any code at all.

## Without writing code

- **Tell us about your TV.** Did it work on your TV model? [Open an issue](../../issues/new/choose) with the brand, the model and the Roku OS version (**Settings → System → About** on the TV). Reports from TV models other than Hisense are especially useful, as are reports from Roku streaming sticks.
- **Report a problem.** Say what you did, what you expected and what happened, and paste anything the installer window or the dashboard showed. For start-up problems, attach `C:\RokuTVParentalControl\logs\service\launcher.log` and the newest `logs\roku-guardian*.log`. These contain your TV's name and its address on your network, but no PIN or password.
- **Improve the words.** The README, the installer messages and the dashboard are written for parents, not engineers. If something confused you, it will confuse others. Suggest a clearer sentence.

## Security problems

Please don't open a public issue for anything that would let someone get around the rules or into the dashboard. Use **Security → Report a vulnerability** on the repository page instead.

## Working on the code

You need Node.js 22 or newer (24 LTS recommended) and git. You don't need a Roku TV: a mock TV is included.

```bash
git clone https://github.com/simonry14/roku-tv-parental-control.git
cd roku-tv-parental-control
npm install
npm run mock-roku      # terminal 1: a pretend TV, with a control panel on http://localhost:8061
npm run dev:mock       # terminal 2: the app, pointed at the pretend TV
npm run set-pin -- 123456 --config config.mock.json   # then open http://localhost:8090
```

[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) explains the configuration, the commands and the mock. [CLAUDE.md](CLAUDE.md) is the design record: the architecture, the decisions behind it, and what has and hasn't been verified on real TVs. Read its _Key decisions_ before changing session accounting, the rules engine or the enforcer.

### Before you open a pull request

- `npm run check` passes (TypeScript, ESLint and all tests), and `npm run format` has been run (Prettier).
- New behavior has a test. Rules and time calculations are pure functions that take `now` as an argument, so they're easy to test, including around midnight and daylight-saving changes.
- Database changes are new migrations in `src/db/migrations/`. Never edit one that has shipped.
- If you change the dashboard, add before and after screenshots at phone size to the pull request.
- If you change the installer (`Install.cmd`, `scripts/windows/*.ps1`), keep it working in Windows PowerShell 5.1, the version every Windows 10 PC has: no `&&`, `??` or ternaries. `.ps1` files are saved as UTF-8 with a BOM and Windows line endings, `.cmd` files as plain ASCII with Windows line endings (`.gitattributes` keeps them that way). Say whether you tried it on a real Windows PC.
- Words people read follow the style already there: plain sentence case, short sentences, no jargon, no all-caps labels.

### Never commit

`.env`, `config.json`, `data/` or `logs/`. They hold your PIN hash, your TV's developer password and your family's viewing history. `.gitignore` already excludes them.

### Artwork and names

Don't add Roku's logo, or other companies' logos and app icons, to the repository. The project name says which TVs it works with; it must never suggest that it comes from Roku.

## Making a release (maintainers)

1. Update `version` in `package.json` (and `VERSION` in `src/app.ts`).
2. Commit, then tag it: `git tag v1.2.3 && git push --tags`.
3. The _Release_ workflow builds `Roku-TV-Parental-Control-Windows.zip` on Windows and attaches it to a draft release. Check the notes, try the zip on a Windows PC, then publish it.

The README links straight to `releases/latest/download/Roku-TV-Parental-Control-Windows.zip`, so keep that file name.

By contributing, you agree that your contribution is licensed under the [MIT license](LICENSE).
