@echo off
"%~dp0..\..\bin\kubectl.exe" --kubeconfig="%~dp0..\..\kubeconfig.yaml" --cache-dir="%~dp0..\..\.kube-cache" --context=k3d-shortener %*
exit /b %errorlevel%
