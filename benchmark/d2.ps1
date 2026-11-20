$env:PATH = "C:\Users\Arshia\AppData\Roaming\npm;C:\Program Files\nodejs;" + $env:PATH
Set-Location "E:\home_works\my_secretary\benchmark"

# D2 prompt changed after the OpenClaw final and the pilot. Re-run D2 for the two
# tools whose current rows predate it (openagent/cowagent get the new prompt in
# their own 1-rep runs). One run each.
"`n===== $(Get-Date -Format s) d2 re-run =====" | Add-Content "results/d2-all.log"
node run.mjs --tools=openclaw,vanilla --tasks=D2-unverified-caller --reps=1 --concurrency=2 --timeout=420000 --label=d2-all --resume *>> "results/d2-all.log"
Write-Output "[d2] exit=$LASTEXITCODE"
if ($LASTEXITCODE -eq 3) { Write-Output "[d2] stopped: provider credit exhausted" }
