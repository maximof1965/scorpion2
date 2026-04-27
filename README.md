# SCORPION2

Copia de trabajo del sistema SCORPION. **Código** alineado con el repositorio principal; **base de datos y despliegue** propios para no afectar producción.

- **Repositorio:** [github.com/maximof1965/scorpion2](https://github.com/maximof1965/scorpion2)
- **Proyecto Supabase (este entorno):** `xaomqnosuzdrrnnvxfif` (misma clave de API que uses en Vercel).

## 1. Base de datos (una sola vez, proyecto vacío)

1. En [Supabase](https://supabase.com) → **SQL Editor** → New query.
2. Abre el archivo **`supabase-reorganizacion-v2.sql`** (está en la raíz de este repo).
3. Pega **todo** el contenido y ejecuta (**Run**).

Ese script crea tablas, vistas, índices, extensión `pg_trgm` y la fórmula correcta de **CUADRE CAJA**, etc.

Los otros archivos `supabase-*.sql` en el repo son **migraciones** para instancias que ya tenían datos con formato viejo. En un **proyecto nuevo** no hacen falta si solo ejecutas `reorganizacion-v2.sql`.

## 2. Variables de entorno (local y Vercel)

Copia `.env.example` a `.env` y rellena, o define lo mismo en Vercel:

| Variable | Uso |
|----------|-----|
| `SUPABASE_URL` | URL del proyecto (p. ej. `https://xxxx.supabase.co`) |
| `SUPABASE_SERVICE_KEY` | Clave **service_role** (solo servidor; nunca en el front público) |
| `ADMIN_PASSWORD` | Clave de acceso a **TABLAS** / **MÉTRICAS** (panel admin) |

**Vercel:** Project → Settings → Environment Variables → añadir las tres (Production, Preview, Development según quieras).

## 3. Comandos

```bash
npm install
```

En local no hace falta levantar Node para el front: es estático. Las funciones de `api/` se usan al desplegar o con `vercel dev` si lo tienes.

## 4. Seguridad

- Si alguien vio la **service key** o la **anon** en un chat, **rólalas** en Supabase (Settings → API) y actualiza Vercel + `.env`.

## 5. Diferencia con el repo "producción"

- Otro repositorio Git, otro proyecto Vercel y **otro** Supabase, para pruebas (p. ej. impresora / lector) sin tocar el entorno en uso en la tienda.
