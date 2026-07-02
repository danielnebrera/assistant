# Despliegue y migraciones de BD

Herramientas **comunes de plataforma** (viven en `assistant/tools/`, llegan a cada proyecto
por `git pull`; **nunca** en el repo de la app). Cubren dos cosas que todo proyecto de The
Seed hace igual:

1. **Migraciones de esquema** incrementales y versionadas (`tools/migrate.js`).
2. **Promoción a producción** (`tools/deploy-to-pro.sh`).

---

## Modelo de entornos y BD

Una sola **BD de empresa** (p. ej. `factory`) con **prefijo de entorno por tabla**:
`dev_` / `test_` / `pro_`. Los tres entornos conviven en la misma BD, separados por prefijo
(lo aplica `shared/db.js`). Cada entorno es un **checkout git independiente** de la misma app:

| Entorno | Carpeta (app de referencia) | Rama git | Proceso pm2 | Puertos |
|---|---|---|---|---|
| dev | `/home/factory/app/dev` | `dev` | `Factory-dev` | 56xx (main 5600) |
| pro | `/home/factory/app/pro` | `pro` | `Factory-pro` | 57xx (main 5700) |
| test| `/home/factory/app/test`| `test`| (tests) | BD aislada, **sin** prefijo |

`pro` es un **git worktree** del mismo repo que `dev` (comparten `.git`). Los `.env` y
`node_modules` están *gitignored*, así que el deploy **no los pisa**.

> **El asistente solo corre en DESARROLLO.** El proceso del propio asistente
> (`Factory-assistant`, en `/home/factory/assistant`, puerto **5620**) vive únicamente en el
> entorno **dev**: es una herramienta de desarrollo. En **producción NO hay asistente** — el
> deploy a pro (`deploy-to-pro.sh`) promociona solo la **app** y nunca levanta ni expone el
> asistente. (El repo `assistant/` sí llega a cada proyecto por `git pull`, pero su proceso
> no se arranca en pro.)

---

## 1. Migraciones — `tools/migrate.js`

### Convención

```
app/<servicio>/sql/
├── 1.install.sql              # esquema COMPLETO actual del servicio (instalación desde cero)
└── migrations/
    ├── 001_expenses_doc_number.sql
    ├── 002_...
    └── NNN_slug.sql            # deltas incrementales, en orden (NNN con ceros)
```

- **El SQL se escribe SIN prefijo de entorno**: `ALTER TABLE expenses ADD COLUMN …`. El
  runner lo reescribe a `dev_expenses` / `pro_expenses` según `--env` (misma lógica que
  `app/tools/migrate_schema.js`). Un fichero puede tener varias sentencias.
- Lo aplicado se registra en la tabla **`<prefijo>schema_migrations`** (una por entorno:
  `dev_schema_migrations`, `pro_schema_migrations`). Así cada entorno lleva su propia cuenta.

### `1.install.sql` vs `migrations/`

- `1.install.sql` = **esquema completo actual** (para instalar un entorno nuevo desde cero).
- `migrations/` = **deltas** para poner al día entornos **ya desplegados**.
- Al crear un entorno nuevo: se carga `1.install.sql` (ya trae todo) y luego se hace
  **`baseline`** para marcar las migraciones existentes como aplicadas (sin re-ejecutarlas).

### Comandos

```bash
# desde assistant/
node tools/migrate.js status   --env=pro --app-dir=/home/factory/app/pro
node tools/migrate.js up        --env=pro --app-dir=/home/factory/app/pro            # aplica pendientes
node tools/migrate.js up        --env=dev --app-dir=/home/factory/app/dev --dry-run  # enseña el SQL prefijado, no ejecuta
node tools/migrate.js baseline  --env=pro --app-dir=/home/factory/app/pro            # marca todo como aplicado SIN ejecutar
```

- `--service=<s>` limita a un servicio (por defecto `all`).
- Credenciales de BD: se leen del `.env` central de `--app-dir` (`DB_HOST/USER/PASSWORD/DATABASE`).
- **Idempotencia:** MySQL **no** tiene `ADD COLUMN IF NOT EXISTS`. Si una migración puede
  encontrarse ya aplicada (p. ej. se parcheó a mano), o bien escríbela defensiva (consultando
  `information_schema`), o usa `baseline` en ese entorno. Un fallo **detiene** el runner y **no**
  registra la migración → se reintenta en el siguiente `up`.

### Escribir una migración (ejemplo)

`app/admin/sql/migrations/001_expenses_doc_number.sql`:
```sql
ALTER TABLE expenses
  ADD COLUMN doc_number varchar(64) DEFAULT NULL AFTER provider_vat;
```
Y **añade también** el cambio a `app/admin/sql/1.install.sql` (que refleja el esquema actual).
Regla: *cada cambio de esquema = una migración nueva + reflejarlo en `1.install.sql`.*

---

## 2. Promoción a producción — `tools/deploy-to-pro.sh`

Orquesta el paso a pro en este orden (todo lo destructivo va **después** del backup;
`set -e`: ante cualquier fallo, aborta):

1. **Backup BD** → `mysqldump` de las tablas `pro_*` a `/home/factory/app/backups/pro_db_<ts>.sql.gz`.
2. **git** → `fetch` + `reset --hard origin/pro` en el worktree de pro (los `.env` se preservan).
3. **npm install** → solo en las carpetas cuyo `package.json` cambió entre commits.
4. **Migraciones** → `node tools/migrate.js up --env=pro`.
5. **Restart** → `pm2 restart Factory-pro` + healthcheck HTTP a `http://127.0.0.1:5700/`.

Al final imprime cómo **revertir** (reset al commit anterior + restaurar el dump + restart).

```bash
assistant/tools/deploy-to-pro.sh --dry-run   # enseña qué cambiaría (código + migraciones), no toca nada
assistant/tools/deploy-to-pro.sh             # pide confirmación (escribir "si")
assistant/tools/deploy-to-pro.sh --yes       # sin confirmación (para automatizar)
```

Config override-able por env: `PRO_DIR`, `ENV_NAME`, `DEPLOY_BRANCH`, `PM2_NAME`,
`BACKUP_DIR`, `HEALTH_URL`. Por defecto apuntan a la app de referencia (factory) en pro.

### Revertir

```bash
git -C /home/factory/app/pro reset --hard <commit_anterior>
zcat /home/factory/app/backups/pro_db_<ts>.sql.gz | mysql -ufactory -p factory
pm2 restart Factory-pro --update-env
```

---

## Reparar el worktree de pro (si `git` falla ahí)

Si el repo se movió de sitio, el `.git` del worktree puede quedar apuntando a una ruta
inexistente (`fatal: not a git repository …/worktrees/pro`). Reparación no destructiva
(no toca los ficheros en ejecución):

```bash
DEVGIT=/home/factory/app/dev/.git         # repo principal (donde vive .git de verdad)
PRO=/home/factory/app/pro
git -C /home/factory/app/dev branch -f pro origin/pro      # rama que sigue el worktree
mkdir -p "$DEVGIT/worktrees/pro"
printf 'ref: refs/heads/pro\n'                       > "$DEVGIT/worktrees/pro/HEAD"
printf '../..\n'                                     > "$DEVGIT/worktrees/pro/commondir"
printf '%s/.git\n' "$PRO"                            > "$DEVGIT/worktrees/pro/gitdir"
printf 'gitdir: %s/worktrees/pro\n' "$DEVGIT"        > "$PRO/.git"
git -C "$PRO" reset -q                                # reconstruye el index sin tocar ficheros
git -C "$PRO" status                                  # comprobar
```

---

## Acceso git al repo `factory` desde este servidor

El repo de la app (`factory`) usa un **deploy key dedicado** (`~/.ssh/id_factory`) con un
alias SSH para no chocar con el deploy key del propio `assistant`:

```
# ~/.ssh/config
Host github-factory
    HostName github.com
    User git
    IdentityFile ~/.ssh/id_factory
    IdentitiesOnly yes
```
El remote `origin` del repo de la app apunta a `git@github-factory:danielnebrera/factory.git`.
Un deploy key pertenece a **un solo** repo: `assistant` y `factory` necesitan claves distintas.
