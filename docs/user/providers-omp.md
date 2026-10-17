# Oh My Pi

Install and configure [Oh My Pi](https://github.com/can1357/oh-my-pi) on the
machine running your environment. Confirm `omp models` lists the models you
want to use, then enable **Oh My Pi** in **Settings > Providers**. Set **Binary
path** if `omp` is not on the server's `PATH`.

T3 Code starts `omp acp` for each thread. OMP keeps its own model credentials,
tools, extensions, and sessions. You can select any model OMP reports, including
models from different inference providers. Refresh provider status after changing
OMP's model or credential configuration.

**Supervised** makes OMP ask before writes and commands. **Auto-accept edits** and
**Auto** use OMP's `write` approval mode. **Full access** uses OMP's `yolo` mode.
OMP questions and approvals appear in the thread on web, desktop, and mobile.

Type `/` at the start of a message to browse OMP's native commands, including
`/usage` and `/skill:<name>`. Select a command and submit it; add task instructions
after a skill name. Namespaced skills use `/skill:<namespace>/<name>`.
`/usage` returns OMP's quota report directly, without a model request. Skill
commands load the skill directly in OMP, then run your task with the model.

Commands are discovered for the thread's working directory. Restart T3 Code
after changing OMP's skill discovery settings to refresh cached command catalogs.
