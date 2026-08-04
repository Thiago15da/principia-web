# RVH Fundición — Sistema de Planeamiento y Control de Producción (PCP)

Sistema interno de gerencia y taller. **No tiene login ni vistas de cliente**:
se abre la URL y entra directo al tablero. Está pensado para correr en la red
privada de la empresa.

| Pantalla | Archivo | Para qué |
|---|---|---|
| **Dashboard PCP** | `index.html` | Prioridad del día: OTs activas con semáforo, rojos primero. |
| **Carga Diaria** | `carga.html` | Parte de producción del turno, en ~10 segundos. |

## Cómo funcionan los datos

La planilla de Google **sigue siendo la base de datos**.

- **Lectura:** la web lee el CSV publicado de la planilla (solo lectura).
- **Escritura:** el CSV publicado no se puede escribir, así que la Carga Diaria
  manda los partes a un **Google Apps Script** publicado como Web App
  (`apps-script/Code.gs`), que es lo único que escribe en la planilla.

```
carga.html ──POST──► Apps Script ──escribe──► planilla ──CSV──► index.html
```

---

## Instalación (una sola vez)

### 1. Preparar la planilla

En la pestaña de órdenes de trabajo, agregá estas dos columnas al final:

| Columna | Para qué |
|---|---|
| `Fecha Prometida` | Fecha de entrega comprometida (formato `DD/MM/AAAA`). Alimenta el semáforo. |
| `Cantidad Completada` | Piezas terminadas. **La actualiza el sistema solo**; no hace falta tocarla a mano. |

Opcionalmente podés agregar una columna `Estado` con los valores
`A realizar`, `En proceso` o `Terminado`. Si no la agregás, el sistema lo
deduce solo a partir del avance.

> El resto de las columnas que ya usás (`OT`, `Cliente`, `Cantidad`,
> `Descripción`, `Material`, `Fecha Ingreso`…) quedan igual. La pestaña
> `registro_diario` se crea sola la primera vez que se guarda un parte.

### 2. Publicar el Apps Script

1. Abrí la planilla → **Extensiones → Apps Script**.
2. Borrá lo que haya y pegá el contenido de `apps-script/Code.gs`.
3. En `CONFIG`, cambiá `TOKEN` por una clave propia (cualquier texto).
4. **Implementar → Nueva implementación → Aplicación web**:
   - *Ejecutar como:* **Yo**
   - *Quién tiene acceso:* **Cualquier usuario**
5. Copiá la URL que termina en `/exec`.

### 3. Conectar la web

En `shared.js`, dentro de `CONFIG`:

```js
API_URL: 'https://script.google.com/macros/s/AKfy.../exec',  // la URL del paso 2
API_TOKEN: 'tu-clave',                                        // el mismo TOKEN del paso 2
```

Listo. Para probar, abrí la URL del `/exec` en el navegador: debe responder
`{"ok":true,...}`.

---

## Reglas del semáforo

Definen el orden del tablero (los rojos **siempre** primero):

| Color | Cuándo |
|---|---|
| 🔴 **Crítico** | Está `A realizar` y pasaron más de **30 días** desde el ingreso, **o** faltan menos de **3 días** para la fecha prometida (incluye vencidas). |
| 🟡 **Alerta** | Faltan menos de **10 días** para la fecha prometida. |
| 🟢 **A tiempo** | El resto. |

Las OTs `Terminado` no entran en la prioridad diaria: quedan fuera del tablero
salvo que se tilde *"Mostrar terminadas"*.

Los umbrales se cambian en `CONFIG` de `shared.js` (`DIAS_ESTANCADA`,
`DIAS_CRITICO`, `DIAS_ALERTA`).

---

## Detalles de operación

- **Al guardar un parte**, el sistema suma la cantidad a `Cantidad Completada`
  de esa OT. El CSV publicado de Google tarda unos minutos en reflejarlo, así
  que el Dashboard muestra el avance nuevo al instante marcándolo como
  *"Sincronizando…"* hasta que la planilla se pone al día.
- **Cargas simultáneas:** el Apps Script usa un lock, así que dos personas
  cargando al mismo tiempo no se pisan el acumulado.
- **Sin conexión:** la app está instalable como PWA y cachea las pantallas.
  Si no llega a la planilla, muestra datos de demostración avisando en pantalla.

## Seguridad — leer antes de exponer esto fuera de la red interna

El sistema **no tiene usuarios ni contraseñas**, por diseño. Eso implica:

- Cualquiera que llegue a la URL ve toda la producción y puede cargar partes.
  Es aceptable en una red privada; **no lo publiques en internet abierto** sin
  poner algo delante (VPN, o al menos autenticación del hosting).
- El `TOKEN` del Apps Script **no es un login**: solo evita que alguien que
  encuentre la URL del Web App escriba en la planilla por accidente. Viaja en
  el código del frontend, así que quien abra la app puede leerlo.
