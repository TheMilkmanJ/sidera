Option Explicit
' Windowless launcher. wscript.exe //B shows no console.
' Opens ChatGPT and Grok in the default browser when that browser can
' load the Sidera extension (Chrome, Edge, Brave, Vivaldi, Opera, or Chromium),
' with the extension already loaded. Firefox and other non-Chromium defaults
' cannot host the extension; a supported browser already on the machine is
' opened instead, and a short notice says which one.
Dim shell, fso, installRoot, extensionDir, manifestPath
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

installRoot = fso.GetParentFolderName(WScript.ScriptFullName)
extensionDir = fso.BuildPath(installRoot, "chrome-extension")
manifestPath = fso.BuildPath(installRoot, "com.sidera.mediator.json")

Dim defaultExe, defaultHive, chosenExe, chosenHive
defaultExe = DefaultBrowserExe()
defaultHive = NativeHive(defaultExe)

If defaultHive <> "" And fso.FileExists(defaultExe) Then
  chosenExe = defaultExe
  chosenHive = defaultHive
Else
  chosenExe = FindFallbackBrowser()
  chosenHive = NativeHive(chosenExe)
  If chosenExe = "" Then
    MsgBox "Sidera loads an extension, so it needs Chrome, Edge, Brave, Vivaldi, or Opera." & vbCrLf & vbCrLf & _
      "None of those browsers is installed, and the current default browser cannot run the extension.", _
      vbExclamation, "Sidera Mediator"
    WScript.Quit 1
  End If
  Dim why
  If defaultExe = "" Then
    why = "Windows did not report a default browser Sidera can use."
  Else
    why = "Your default browser (" & fso.GetFileName(defaultExe) & ") cannot load the Sidera extension."
  End If
  MsgBox why & vbCrLf & vbCrLf & "Opening " & FriendlyName(chosenExe) & " instead." & vbCrLf & _
    "Set Chrome, Edge, Brave, Vivaldi, or Opera as the default browser to open that one next time.", _
    vbInformation, "Sidera Mediator"
End If

RegisterHost chosenHive, manifestPath
' --load-extension is a free bonus, not the install path: branded Google
' Chrome 137+ (May 2025) ignores the flag with a warning, so on Chrome the
' extension is loaded once by hand instead (chrome://extensions -> Developer
' mode -> Load unpacked; see docs/INSTALL.md). Edge, Brave, Vivaldi, Opera and
' Chromium still honor the flag, and an already-loaded unpacked extension
' stays in the profile either way.
' Each site gets its own window so neither side sits as a hidden background
' tab, which Chrome would throttle during long runs.
shell.Run """" & chosenExe & """ --load-extension=""" & extensionDir & """ --silent-debugger-extension-api --new-window https://chatgpt.com/", 1, False
WScript.Sleep 1500
shell.Run """" & chosenExe & """ --new-window https://grok.com/", 1, False

Function RegRead(path)
  On Error Resume Next
  RegRead = shell.RegRead(path)
  If Err.Number <> 0 Then
    Err.Clear
    RegRead = ""
  End If
End Function

Function ExeFromCommand(cmd)
  Dim trimmed, endq, sp
  trimmed = Trim(cmd)
  ExeFromCommand = ""
  If trimmed = "" Then Exit Function
  If Left(trimmed, 1) = """" Then
    endq = InStr(2, trimmed, """")
    If endq > 2 Then
      ExeFromCommand = Mid(trimmed, 2, endq - 2)
      Exit Function
    End If
  End If
  sp = InStr(trimmed, " ")
  If sp > 1 Then
    ExeFromCommand = Left(trimmed, sp - 1)
  Else
    ExeFromCommand = trimmed
  End If
End Function

Function DefaultBrowserExe()
  Dim progId, cmd
  progId = RegRead("HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\https\UserChoice\ProgId")
  If progId = "" Then
    progId = RegRead("HKCU\Software\Microsoft\Windows\Shell\Associations\UrlAssociations\http\UserChoice\ProgId")
  End If
  cmd = ""
  If progId <> "" Then
    cmd = RegRead("HKCU\Software\Classes\" & progId & "\shell\open\command\")
    If cmd = "" Then
      cmd = RegRead("HKLM\Software\Classes\" & progId & "\shell\open\command\")
    End If
  End If
  DefaultBrowserExe = ExeFromCommand(cmd)
End Function

' Native-messaging hive for a Chromium browser, or "" when this executable
' cannot load the extension. Keep this in step with the hive list in
' setup_prerequisites.ps1 and uninstall.ps1.
Function NativeHive(exePath)
  Dim folder, exe
  NativeHive = ""
  If exePath = "" Then Exit Function
  folder = LCase(exePath)
  exe = LCase(fso.GetFileName(exePath))
  If InStr(folder, "\chrome sxs\") > 0 Then
    NativeHive = "Software\Google\Chrome SxS"
  ElseIf InStr(folder, "\chrome dev\") > 0 Then
    NativeHive = "Software\Google\Chrome Dev"
  ElseIf InStr(folder, "\chrome beta\") > 0 Then
    NativeHive = "Software\Google\Chrome Beta"
  ElseIf exe = "chrome.exe" Then
    NativeHive = "Software\Google\Chrome"
  ElseIf InStr(folder, "\edge sxs\") > 0 Or InStr(folder, "\edge canary\") > 0 Then
    NativeHive = "Software\Microsoft\Edge SxS"
  ElseIf InStr(folder, "\edge dev\") > 0 Then
    NativeHive = "Software\Microsoft\Edge Dev"
  ElseIf InStr(folder, "\edge beta\") > 0 Then
    NativeHive = "Software\Microsoft\Edge Beta"
  ElseIf exe = "msedge.exe" Then
    NativeHive = "Software\Microsoft\Edge"
  ElseIf exe = "brave.exe" Then
    NativeHive = "Software\BraveSoftware\Brave-Browser"
  ElseIf exe = "vivaldi.exe" Then
    NativeHive = "Software\Vivaldi"
  ElseIf InStr(folder, "opera gx") > 0 Then
    NativeHive = "Software\Opera Software\Opera GX Stable"
  ElseIf exe = "opera.exe" Then
    NativeHive = "Software\Opera Software\Opera Stable"
  ElseIf exe = "chromium.exe" Then
    NativeHive = "Software\Chromium"
  End If
End Function

Function FriendlyName(exePath)
  Dim exe
  exe = LCase(fso.GetFileName(exePath))
  Select Case exe
    Case "chrome.exe"
      FriendlyName = "Google Chrome"
    Case "msedge.exe"
      FriendlyName = "Microsoft Edge"
    Case "brave.exe"
      FriendlyName = "Brave"
    Case "vivaldi.exe"
      FriendlyName = "Vivaldi"
    Case "opera.exe"
      FriendlyName = "Opera"
    Case "chromium.exe"
      FriendlyName = "Chromium"
    Case Else
      FriendlyName = fso.GetFileName(exePath)
  End Select
End Function

Sub RegisterHost(hive, manifest)
  On Error Resume Next
  If hive = "" Or Not fso.FileExists(manifest) Then Exit Sub
  shell.RegWrite "HKCU\" & hive & "\NativeMessagingHosts\com.sidera.mediator\", manifest, "REG_SZ"
  Err.Clear
End Sub

Function FindFallbackBrowser()
  Dim candidates, i, expanded
  candidates = Array( _
    "%ProgramFiles%\Google\Chrome\Application\chrome.exe", _
    "%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe", _
    "%LocalAppData%\Google\Chrome\Application\chrome.exe", _
    "%ProgramFiles(x86)%\Microsoft\Edge\Application\msedge.exe", _
    "%ProgramFiles%\Microsoft\Edge\Application\msedge.exe", _
    "%LocalAppData%\Microsoft\Edge\Application\msedge.exe", _
    "%ProgramFiles%\BraveSoftware\Brave-Browser\Application\brave.exe", _
    "%LocalAppData%\BraveSoftware\Brave-Browser\Application\brave.exe", _
    "%LocalAppData%\Vivaldi\Application\vivaldi.exe", _
    "%LocalAppData%\Programs\Opera\opera.exe", _
    "%LocalAppData%\Programs\Opera GX\opera.exe" _
  )
  FindFallbackBrowser = ""
  For i = 0 To UBound(candidates)
    expanded = shell.ExpandEnvironmentStrings(candidates(i))
    If fso.FileExists(expanded) Then
      FindFallbackBrowser = expanded
      Exit Function
    End If
  Next
End Function
