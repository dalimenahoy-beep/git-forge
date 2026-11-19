# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/dalimenahoy-beep/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/dalimenahoy-beep/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A standalone, GitHub-compatible git forge in a single Node process, standard library only — no git binary. It implements git smart HTTP (upload-pack protocol v2, receive-pack v0) with its own object store, the REST v3 API for repositories, contents, labels, issues and pull requests (with squash merge), a GraphQL v4 endpoint, and an MCP endpoint, all over one shared store. On start it binds an ephemeral port, registers it with $MAKEFUN_ENV_URL/register, and exits when the environment reports done.

## Run it

```sh
node main.ts
```

---

<sub>Entered on [make.fun](https://make.fun/?ref=fgm20ny4&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
