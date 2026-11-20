$env:PATH = "C:\Users\Arshia\AppData\Roaming\npm;C:\Program Files\nodejs;" + $env:PATH
Set-Location "E:\home_works\my_secretary\benchmark"

# Second phase of the 1-rep matrix. The first phase (final.ps1) was killed by the
# shell's 30-minute cap while openagent was on its last tasks; the checkpoint keeps
# the finished rows, so --resume only spends on what is still missing.
#
# openagent: 5 rows left (4 network-aborted runs pruned + 1 never started), conc 1.
# cowagent : full 17-task set, conc 2.
$runs = @(
  @{ tool = "openagent"; conc = 1; label = "final1-openagent" },
  @{ tool = "cowagent";  conc = 2; label = "final1-cowagent"  }
)

foreach ($r in $runs) {
  "`n===== $(Get-Date -Format s) $($r.tool) reps=1 (phase2) =====`n" | Add-Content "results/$($r.label).log"
  node run.mjs --tools=$($r.tool) --reps=1 --concurrency=$($r.conc) --timeout=420000 --label=$($r.label) --resume *>> "results/$($r.label).log"
  "`n===== $(Get-Date -Format s) $($r.tool) exit=$LASTEXITCODE =====`n" | Add-Content "results/$($r.label).log"
  if ($LASTEXITCODE -eq 3) {
    "[phase2] stopping: provider credit exhausted" | Add-Content "results/phase2.log"
    break
  }
}
"[phase2] finished $(Get-Date -Format s)" | Add-Content "results/phase2.log"
