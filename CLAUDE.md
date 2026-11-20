# Sistema de Desarrollo "Supre Pos"

Este repositorio opera bajo una arquitectura de 4 agentes especializados. Claude Code debe consultar y seguir las directivas de cada archivo según el rol o fase solicitada.

## Ubicación de los Agentes
- **Agente Director & Arquitecto:** `app-supre-pos/instructions/00-director-pos.md`
- **Agente Frontend & UI:** `app-supre-pos/instructions/01-frontend-pos.md`
- **Agente Backend & Apps Script:** `app-supre-pos/instructions/02-backend-pos.md`
- **Agente Integrador & QA:** `app-supre-pos/instructions/03-integrador-pos.md`

---

## Reglas de Orquestación

### 1. Solicitud de Nuevo Módulo (Comportamiento por Defecto)
Cuando el usuario pida diseñar, crear o planificar un módulo nuevo:
- Carga y sigue `app-supre-pos/instructions/00-director-pos.md`.
- Genera primero el **Contrato de Datos JSON** unificado antes de escribir código.
- Presenta el entregable estructurado en 3 fases secuenciales:
  1. Directivas de diseño e interfaz para el Frontend.
  2. Directivas de base de datos y Google Apps Script para el Backend.
  3. Directivas de conexión y simulación para el Integrador.

### 2. Tareas de Frontend / UI
Cuando la tarea sea maquetar, estilizar o ajustar la interfaz:
- Carga y sigue `app-supre-pos/instructions/01-frontend-pos.md`.
- Modifica **únicamente** el contenedor `<main class="w-full pt-16 px-space-lg py-space-lg bg-surface min-h-screen">`.
- **Nunca** alteres el `<aside>` (menú lateral) ni el `<header>` (barra superior).
- Aplica los tokens Tailwind corporativos (`bg-surface`, `text-primary`, etc.), íconos de Material Symbols y vista previa local con `FileReader`.

### 3. Tareas de Backend / Google Apps Script
Cuando la tarea involucre hojas de cálculo o lógica de servidor:
- Carga y sigue `app-supre-pos/instructions/02-backend-pos.md`.
- Centraliza todo en `doPost(e)` y `doGet(e)` dentro de `Código.gs` con concurrencia segura vía `LockService`.
- No asumas edición directa de Google Sheets; genera siempre la función `inicializarPestanaX()`.
- Procesa subidas Base64 a Drive y retorna siempre `{ result, data, error }` junto a `urlDirecta` y `urlDrive`.

### 4. Tareas de Integración y Conectividad (apiService.js)
Cuando la tarea involucre conectar UI con datos o pruebas:
- Carga y sigue `app-supre-pos/instructions/03-integrador-pos.md`.
- Canaliza las peticiones a través de `ApiService.ejecutarAccion(action, payload)`.
- Mantén el flag `const MODO_PRODUCCION = false;` simulando respuestas en `LocalStorage` con 300ms de delay.
- Añade depuración en consola (`console.group`) indicando si corre en `[MODO LOCAL]` o `[PRODUCCIÓN]`.