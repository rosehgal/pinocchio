# Terminal demo for the README, on the sample logs from scripts/demo.ts.
# Run from the repo root: vhs scripts/demo.tape
Output docs/demo.gif
Output docs/demo.mp4

Set Shell bash
Set Theme "Catppuccin Mocha"
Set FontSize 19
Set Width 1240
Set Height 700
Set Padding 28
Set TypingSpeed 55ms
Set WindowBar Colorful
Set WindowBarSize 36

Hide
Type `export PS1='\[\e[33m\]~/code/ledger\[\e[0m\] $ ' D=$(mktemp -d) && node scripts/demo.ts $D && export CLAUDE_CONFIG_DIR=$D/claude CODEX_HOME=$D/codex R=$PWD && npx() { shift; node $R/src/cli.ts "$@"; } && cd $D/code/ledger && clear`
Enter
Sleep 1s
Show

Sleep 600ms
Type "npx pinocchio-cli"
Sleep 400ms
Enter
Sleep 7s

Type "clear" Enter
Type "npx pinocchio-cli standup"
Sleep 400ms
Enter
Sleep 6s
