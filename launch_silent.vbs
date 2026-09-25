Option Explicit
' Windowless launcher. wscript.exe //B shows no console.
' Chrome opens ChatGPT and Grok with the Sidera extension already loaded,
' so the operator only pairs LEFT and RIGHT and presses Start.
Dim shell, fso, chrome, installRoot, extensionDir
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

installRoot = fso.GetParentFolderName(WScript.ScriptFullName)
extensionDir = fso.BuildPath(installRoot, "chrome-extension")

chrome = shell.ExpandEnvironmentStrings("%ProgramFiles%\Google\Chrome\Application\chrome.exe")
If Not fso.FileExists(chrome) Then
  chrome = shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe")
End If
If Not fso.FileExists(chrome) Then
  chrome = shell.ExpandEnvironmentStrings("%LocalAppData%\Google\Chrome\Application\chrome.exe")
End If

If fso.FileExists(chrome) Then
  shell.Run """" & chrome & """ --load-extension=""" & extensionDir & """ --silent-debugger-extension-api --new-window https://chatgpt.com/ https://grok.com/", 1, False
Else
  shell.Run "https://chatgpt.com/", 1, False
  shell.Run "https://grok.com/", 1, False
End If
