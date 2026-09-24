Option Explicit
' Windowless launcher. wscript.exe //B shows no console.
' Chrome itself opens normally so the operator can pair LEFT and RIGHT.
Dim shell, fso, chrome
Set shell = CreateObject("WScript.Shell")
Set fso = CreateObject("Scripting.FileSystemObject")

chrome = shell.ExpandEnvironmentStrings("%ProgramFiles%\Google\Chrome\Application\chrome.exe")
If Not fso.FileExists(chrome) Then
  chrome = shell.ExpandEnvironmentStrings("%ProgramFiles(x86)%\Google\Chrome\Application\chrome.exe")
End If
If Not fso.FileExists(chrome) Then
  chrome = shell.ExpandEnvironmentStrings("%LocalAppData%\Google\Chrome\Application\chrome.exe")
End If

If fso.FileExists(chrome) Then
  shell.Run """" & chrome & """ --new-window https://chatgpt.com/ https://grok.com/", 1, False
Else
  shell.Run "https://chatgpt.com/", 1, False
  shell.Run "https://grok.com/", 1, False
End If
