# Changelog

<!-- rman:documented-up-to f5367d9e2e10715753a69a9dea67e0d5a10c7798 -->

## v1.1.2 (2026-11-27)

### 📚 Documentation

- point at the postgrejs notes where they now live (5ac59a0)
- add the security policy, code of conduct and issue templates (513cd99)
- move doc/ to docs/ (5288269)
- describe the repository as it is, not as the round that preceded it (da4d83c)

### 📦 Build System

- install, lock and publish with pnpm (dff83fb)

### 🤖 Continuous Integration

- send coverage from the release, add the main-from-dev guard, declare job permissions (02a86ea)
- publish through Trusted Publishing alone (8d6d1dd)

### 🧹 Chores

- sync lockfile [skip ci] (6ec69ae)
- take the standard config files and add the missing root scripts (2fab973)
- drop the Renovate config (5698c17)
- share the Claude settings and name where a handoff note goes (8e43bc2)
- keep graphify's git hooks out of git (fb7ec10)

### 💬 General Changes

- Merge remote-tracking branch 'origin/dev' into chore/standards (0c75c6c)
- Merge pull request #11 from panates/docs/claude-md-state (27bc1a3)

---

## v1.1.1 (2026-11-15)

### 🧹 Chores

- remove `dpdm` dependency and mark certain packages as peer dependencies in lockfile (6e8c855)
- remove auto-changelog and associated template files (574b3ff)
- sync lockfile (7c987ed)
- **deps:** upgrade dependencies (53d7ebf)
- normalize repository.url for rman-preset 2.x package.json check (0027fe9)

### 💬 General Changes

- Merge remote-tracking branch 'origin/dev' into dev (bab7b65)

---

## v1.1.0 (2026-10-06)

### ✨ Features

- **benchmark:** measure both adapters at two levels, and generate the report (8d473b6)

### 📚 Documentation

- correct the claim that `BEGIN` reaches Prisma's query event (357e9a8)

### 🤖 Continuous Integration

- finish the rman 2.x migration, and repair a CI that could not pass (2a741e6)

### 🧹 Chores

- move the toolchain to rman, and raise the postgrejs floor (914fdd9)
- update dependencies to latest versions (0e55d4d)

---

## Changelog

### [v1.0.5](https://github.com/panates/postgrejs-prisma/compare/v1.0.4...v1.0.5) - 

#### 📖 Documentation Changes

- docs: add a Development section @Eray Hanoğlu 

### [v1.0.4](https://github.com/panates/postgrejs-prisma/compare/v1.0.3...v1.0.4) -  23 September 2026 

### [v1.0.3](https://github.com/panates/postgrejs-prisma/compare/v1.0.2...v1.0.3) -  23 September 2026 

#### 📖 Documentation Changes

- docs: add the npm, CI and coverage badges @Eray Hanoğlu 

### [v1.0.2](https://github.com/panates/postgrejs-prisma/compare/v1.0.1...v1.0.2) -  23 September 2026 

#### 🚀 New Features

- feat: run a multi-statement $executeRaw as a script @Eray Hanoğlu 

#### 📖 Documentation Changes

- docs: lead with the result, and correct what the suite disproved @Eray Hanoğlu 

#### 🧪 Changes to Test Assests

- test: stop the suite comparison reporting a crashed run as clean @Eray Hanoğlu 

### [v1.0.1](https://github.com/panates/postgrejs-prisma/compare/v1.0.0...v1.0.1) -  22 September 2026 

#### 📖 Documentation Changes

- docs: open the README with how to install and use it @Eray Hanoğlu 

## [v1.0.0](https://github.com/panates/postgrejs-prisma/compare/v0.0.1...v1.0.0) -  22 September 2026 

#### 🚀 New Features

- feat: a Prisma driver adapter for PostgreJS @Eray Hanoğlu 

### v0.0.1

#### 💬 General Changes

- Initial commit @Eray Hanoglu 
