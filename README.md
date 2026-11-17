# PB VPN

En flot WireGuard-klient til Windows med live download, upload og latency.

- Træk/slip, vælg eller indsæt `.conf`-filer (Ctrl+V virker også)
- Live upload/download-grafer og latency (TCP-måling, standard `8.8.8.8:53`)
- DNS er som standard **8.8.8.8** (kan ændres under Indstillinger)
- Private nøgler gemmes krypteret (Windows DPAPI); den kørende konfiguration ligger kun i en admin-låst mappe, mens du er forbundet
- Systembakke, start med Windows, auto-forbind
- Installer (NSIS) + automatisk opdatering via GitHub Releases

## Udvikling

```powershell
npm install
npm start        # kør som administrator for at kunne forbinde
```

## Byg installer

```powershell
npm run dist     # -> dist\PB-VPN-Setup-<version>.exe
```

## Automatiske opdateringer (online)

1. Opret et GitHub-repo og ret `owner` / `repo` i `package.json` under `build.publish`.
2. Push koden. Når du vil udgive en ny version:
   ```powershell
   npm version patch          # hæver version, laver git-tag
   git push --follow-tags     # GitHub Actions bygger og udgiver installeren
   ```
3. Installerede klienter tjekker ved start og hver 4. time, henter opdateringen i baggrunden og tilbyder "Genstart og opdatér".

> Repoet skal være offentligt, eller du skal give klienterne et token, hvis det er privat.
> Du kan også udgive manuelt: `set GH_TOKEN=...` og `npm run release`.

## Krav

- Windows 10/11 x64
- [WireGuard for Windows](https://www.wireguard.com/install/) – appen tilbyder at installere den automatisk
- Appen kræver administratorrettigheder (installeren sætter dette op)

## Signering

For at undgå SmartScreen-advarsler bør installeren kodesigneres (`CSC_LINK` / `CSC_KEY_PASSWORD` som secrets i GitHub Actions).
