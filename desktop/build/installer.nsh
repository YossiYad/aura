; Remembers the name the installer was downloaded under. A server names it after itself
; (Aura@music.example.exe, see selfhost/private-app/nginx.conf), so the app can offer that
; address on its first run instead of asking for it to be typed (main.js, install.js).
!macro customInstall
  FileOpen $0 "$INSTDIR\installed-from.txt" w
  FileWrite $0 "$EXEFILE"
  FileClose $0
!macroend
