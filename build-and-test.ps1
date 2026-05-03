#Requires -Version 5.1
param([switch]$SkipBuild)

$SDK      = "C:\Users\Silex\AppData\Local\Android\Sdk"
$ADB      = "$SDK\platform-tools\adb.exe"
$EMULATOR = "$SDK\emulator\emulator.exe"
$AVD      = "Medium_Phone_API_36.1"
$PACKAGE  = "app.rork.meshpay_lora_messaging_btc"
$APK      = "$PSScriptRoot\android\app\build\outputs\apk\debug\app-debug.apk"

$env:ANDROID_HOME     = $SDK
$env:ANDROID_SDK_ROOT = $SDK

# ---------------------------------------------------------------------------
# 1. Lancer l'emulateur si pas deja actif
# ---------------------------------------------------------------------------
Write-Host "[1/4] Emulateur" -ForegroundColor Cyan

$running = & $ADB devices 2>&1 | Select-String "^emulator"

if ($running) {
    Write-Host "  Deja actif : $($running.Line.Split()[0])"
} else {
    Write-Host "  Demarrage de $AVD..."
    Start-Process -FilePath $EMULATOR `
        -ArgumentList @("-avd", $AVD, "-no-snapshot-save", "-no-audio", "-gpu", "swiftshader_indirect")

    # ---------------------------------------------------------------------------
    # 2. Attendre que le boot soit termine
    # ---------------------------------------------------------------------------
    Write-Host "[2/4] Attente boot Android (max 3 min)..." -ForegroundColor Cyan

    & $ADB wait-for-device

    $elapsed = 0
    $booted  = $false
    while ($elapsed -lt 180) {
        Start-Sleep -Seconds 5
        $elapsed += 5
        $val = (& $ADB shell getprop sys.boot_completed 2>$null).Trim()
        Write-Host "  [${elapsed}s] boot_completed = '$val'"
        if ($val -eq "1") {
            $booted = $true
            break
        }
    }

    if (-not $booted) {
        Write-Error "Timeout : l'emulateur n'a pas boote en 3 minutes."
        exit 1
    }

    & $ADB shell input keyevent 82 2>$null
    Write-Host "  Emulateur pret." -ForegroundColor Green
}

# ---------------------------------------------------------------------------
# 3. Build ou installer l'APK
# ---------------------------------------------------------------------------
Write-Host "[3/4] Build / Install" -ForegroundColor Cyan

Set-Location $PSScriptRoot

if ($SkipBuild) {
    if (-not (Test-Path $APK)) {
        Write-Error "-SkipBuild : aucun APK trouve a $APK"
        exit 1
    }
    Write-Host "  Installation de l'APK existant..."
    & $ADB install -r $APK
    if ($LASTEXITCODE -ne 0) { Write-Error "adb install a echoue."; exit 1 }
    Write-Host "  APK installe." -ForegroundColor Green

} elseif (Test-Path $APK) {
    Write-Host "  APK debug present -- installation directe (pas de rebuild)..."
    & $ADB install -r $APK
    if ($LASTEXITCODE -ne 0) { Write-Error "adb install a echoue."; exit 1 }
    Write-Host "  APK installe." -ForegroundColor Green

} else {
    Write-Host "  Aucun APK -- build complet avec npx expo run:android..."
    Write-Host "  (expo prebuild sera lance si android/ est absent, ~2 min)" -ForegroundColor Yellow
    npx expo run:android --no-bundler
    if ($LASTEXITCODE -ne 0) { Write-Error "expo run:android a echoue."; exit 1 }
    Write-Host "  Build + install termine." -ForegroundColor Green
}

# Lancer l'app (no-op si expo run:android l'a deja fait)
Write-Host "  Lancement de l'app..."
$activity = & $ADB shell `
    "cmd package resolve-activity --brief -a android.intent.action.MAIN -c android.intent.category.LAUNCHER $PACKAGE" `
    2>$null | Select-String "/" | Select-Object -First 1 -ExpandProperty Line

if ($activity) {
    & $ADB shell am start -n $activity.Trim() | Out-Null
} else {
    & $ADB shell monkey -p $PACKAGE -c android.intent.category.LAUNCHER 1 | Out-Null
}

Start-Sleep -Seconds 2

# ---------------------------------------------------------------------------
# 4. Logcat filtre sur le PID de l'app
# ---------------------------------------------------------------------------
Write-Host "[4/4] Logcat (Ctrl+C pour arreter)" -ForegroundColor Cyan

& $ADB logcat -c 2>$null

$appPid = (& $ADB shell pidof -s $PACKAGE 2>$null).Trim()
if ($appPid) {
    Write-Host "  Filtre sur PID $appPid ($PACKAGE)" -ForegroundColor Green
    & $ADB logcat -v time --pid=$appPid
} else {
    Write-Host "  PID introuvable -- filtre generique ReactNative" -ForegroundColor Yellow
    & $ADB logcat -v time ReactNative:V ReactNativeJS:V Expo:V "*:W"
}
