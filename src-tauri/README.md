# Datran desktop shell (Tauri v1)

Wraps the web portal (`diocom-app`, expected on http://localhost:3001) in a native window, with a system tray.

```bash
npm --prefix ../diocom-app run dev -- -p 3001   # or let `tauri dev` start it (beforeDevCommand)
npx @tauri-apps/cli@1 dev
```

## Icons
`icons/` is generated from one 1024×1024 PNG. The current icon is a placeholder (a cyan "D"). To replace it:

```bash
npx @tauri-apps/cli@1 icon path/to/logo.png -o icons
```

## Windows: paths with spaces
With the GNU toolchain (WinLibs/MinGW), `windres` cannot handle a space in the build directory path. This repo lives under `My Preojects`, so that applies here. Point the build output at a path without spaces:

```powershell
$env:CARGO_TARGET_DIR = "$env:LOCALAPPDATA\Temp\datran-tauri-target"
cargo check   # or: npx @tauri-apps/cli@1 build
```

The MSVC toolchain (`rustup default stable-msvc` with the Visual Studio Build Tools) does not have this problem.
