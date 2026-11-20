param(
  [switch]$IncludeOpenclaw
)
$ErrorActionPreference = "Continue"
$env:PATH = "C:\Users\Arshia\AppData\Roaming\npm;C:\Program Files\nodejs;" + $env:PATH
Set-Location "E:\home_works\my_secretary\benchmark"

# 1 rep per tool (credit-constrained run). OpenClaw and Vanilla already have
# 1-rep data (final openclaw rep1 / revalidated pilot), so only the two tools
# with no usable data are run here. OpenAgent is sequential: one server per run,
# shared SQLite store.
$runs = @(
  @{ tool = "openagent"; conc = 1; label = "final1-openagent" },
  @{ tool = "cowagent";  conc = 2; label = "final1-cowagent"  }
)

foreach ($r in $runs) {
  Write-Output "[final1] starting $($r.tool) $(Get-Date -Format 'HH:mm')"
  "`n===== $(Get-Date -Format s) $($r.tool) reps=1 =====" | Add-Content "results/$($r.label).log"
  node run.mjs --tools=$($r.tool) --reps=1 --concurrency=$($r.conc) --timeout=420000 --label=$($r.label) --resume *>> "results/$($r.label).log"
  Write-Output "[final1] finished $($r.tool) exit=$LASTEXITCODE"
  if ($LASTEXITCODE -eq 3) {
    Write-Output "[final1] stopping: provider credit exhausted (checkpoint kept, re-run this script to resume)"
    break
  }
}
Write-Output "[final1] all done"
