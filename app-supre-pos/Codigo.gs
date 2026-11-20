/**
 * =====================================================================
 * SUPRE POS - BACKEND SERVERLESS (Google Apps Script & Google Sheets)
 * =====================================================================
 * Arquitectura:
 * - Base de Datos: Google Sheets (Pestañas dedicadas con auto-inicialización)
 * - Concurrencia: LockService con timeout de 30s en transacciones
 * - Archivos: Google Drive (almacenamiento de fotos en Base64 con enlace público lh3)
 * - CORS-Friendly: doGet y doPost con respuestas JSON estándar
 */
// CONFIGURACIÓN DE CARPETA DE DRIVE PARA IMÁGENES (Opcional: Si está vacío, usa la raíz de Drive)
const ID_CARPETA_DRIVE = ""; 
// Nombres de Pestañas
const TABLAS = {
  CONFIG: "CONFIGURACION",
  PRODUCTOS: "PRODUCTOS",
  CATEGORIAS: "CATEGORIAS",
  CLIENTES: "CLIENTES",
  VENTAS: "VENTAS",
  DETALLE_VENTAS: "DETALLE_VENTAS",
  GASTOS: "GASTOS",
  MOVIMIENTOS_STOCK: "MOVIMIENTOS_STOCK",
  PEDIDOS: "PEDIDOS"
};
/**
 * Endpoint GET: Consultas y Verificación de Estado
 */
function doGet(e) {
  try {
    const accion = e && e.parameter ? e.parameter.accion : "PING";
    
    if (accion === "PING") {
      return jsonResponse({
        result: "success",
        data: {
          app: "SUPRE POS Backend",
          version: "1.0.0",
          status: "ONLINE",
          timestamp: new Date().toISOString()
        }
      });
    }
    if (accion === "OBTENER_DATOS_INICIALES") {
      inicializarTodasLasPestanas();
      const ss = SpreadsheetApp.getActiveSpreadsheet();
      return jsonResponse({
        result: "success",
        data: obtenerDatosIniciales(ss)
      });
    }
    return jsonResponse({ result: "error", error: "Acción GET no reconocida" });
  } catch (err) {
    return jsonResponse({ result: "error", error: err.toString() });
  }
}
/**
 * Endpoint POST: Mutaciones y Transacciones concurrentes
 */
function doPost(e) {
  // Manejo de concurrencia con LockService (30s)
  const lock = LockService.getScriptLock();
  try {
    const lockSuccess = lock.tryLock(30000);
    if (!lockSuccess) {
      return jsonResponse({
        result: "error",
        error: "El servidor está ocupado procesando otra transacción. Por favor, reintenta."
      });
    }
    inicializarTodasLasPestanas();
    const requestData = JSON.parse(e.postData.contents);
    const accion = requestData.action;
    const payload = requestData.payload;
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    let respuesta = null;
    switch (accion) {
      case "OBTENER_DATOS_INICIALES":
        respuesta = obtenerDatosIniciales(ss);
        break;
      case "REGISTRAR_VENTA":
        respuesta = registrarVentaTransaccional(ss, payload);
        break;
      case "GUARDAR_PRODUCTO":
        respuesta = guardarOActualizarProducto(ss, payload);
        break;
      case "ELIMINAR_PRODUCTO":
        respuesta = eliminarProducto(ss, payload.id);
        break;
      case "GUARDAR_CLIENTE":
        respuesta = guardarOActualizarCliente(ss, payload);
        break;
      case "ACTUALIZAR_ESTADO_PEDIDO":
        respuesta = actualizarEstadoPedido(ss, payload.idVenta, payload.nuevoEstado);
        break;
      case "REGISTRAR_GASTO":
        respuesta = registrarGasto(ss, payload);
        break;
      case "ACTUALIZAR_CONFIG":
        respuesta = actualizarConfiguracion(ss, payload);
        break;
      case "GUARDAR_CATEGORIA":
        respuesta = guardarOActualizarCategoria(ss, payload);
        break;
      case "ELIMINAR_CATEGORIA":
        respuesta = eliminarCategoria(ss, payload.id);
        break;
      case "GUARDAR_PEDIDO":
        respuesta = guardarOActualizarPedido(ss, payload);
        break;
      case "CONFIRMAR_PEDIDO":
        respuesta = confirmarPedido(ss, payload.id);
        break;
      case "ANULAR_PEDIDO":
        respuesta = anularPedido(ss, payload.id);
        break;
      case "SUBIR_IMAGEN":
        respuesta = subirImagenADrive(payload.base64Data, payload.nombreArchivo);
        break;
      default:
        throw new Error("Acción desconocida: " + accion);
    }
    return jsonResponse({ result: "success", data: respuesta });
  } catch (err) {
    return jsonResponse({ result: "error", error: err.toString() });
  } finally {
    lock.releaseLock();
  }
}
/**
 * Obtener todos los datos iniciales de las hojas
 */
function obtenerDatosIniciales(ss) {
  const config = sheetToObjects(ss.getSheetByName(TABLAS.CONFIG))[0] || {};
  const productos = sheetToObjects(ss.getSheetByName(TABLAS.PRODUCTOS));
  const categorias = sheetToObjects(ss.getSheetByName(TABLAS.CATEGORIAS));
  const clientes = sheetToObjects(ss.getSheetByName(TABLAS.CLIENTES));
  const ventas = sheetToObjects(ss.getSheetByName(TABLAS.VENTAS));
  const detalleVentas = sheetToObjects(ss.getSheetByName(TABLAS.DETALLE_VENTAS));
  const gastos = sheetToObjects(ss.getSheetByName(TABLAS.GASTOS));
  const pedidos = sheetToObjects(ss.getSheetByName(TABLAS.PEDIDOS)).map(filaAPedido);
  return {
    config,
    productos,
    categorias,
    clientes,
    ventas,
    detalleVentas,
    gastos,
    pedidos
  };
}
/**
 * Registro de Venta con descuento de stock y trazabilidad
 */
function registrarVentaTransaccional(ss, ventaData) {
  const shVentas = ss.getSheetByName(TABLAS.VENTAS);
  const shDetalle = ss.getSheetByName(TABLAS.DETALLE_VENTAS);
  const shClientes = ss.getSheetByName(TABLAS.CLIENTES);
  const idVenta = ventaData.id || "VNT-" + Utilities.getUuid().substring(0, 8).toUpperCase();
  const fecha = ventaData.fecha || new Date().toISOString();
  const ticket = ventaData.ticket || "TCK-" + Math.floor(100000 + Math.random() * 900000);
  const pedido = ventaData.idPedido ? obtenerPedido(ss, ventaData.idPedido) : null;
  if (pedido && (pedido.estado === "Cobrado" || pedido.estado === "Anulado")) {
    throw new Error("El pedido " + pedido.numero + " ya está " + pedido.estado.toLowerCase());
  }
  // 1. Guardar en VENTAS
  shVentas.appendRow([
    idVenta,
    ticket,
    fecha,
    ventaData.idCliente || "PUBLICO_GENERAL",
    ventaData.nombreCliente || "Público General",
    ventaData.metodoPago || "Efectivo",
    Number(ventaData.subtotal || 0),
    Number(ventaData.descuento || 0),
    Number(ventaData.impuesto || 0),
    Number(ventaData.total || 0),
    Number(ventaData.montoRecibido || ventaData.total || 0),
    Number(ventaData.cambio || 0),
    ventaData.estadoPago || "Pagado",
    ventaData.estadoEntrega || "Entregado",
    ventaData.vendedor || "Cajero Principal",
    ventaData.notas || ""
  ]);
  // 2. Guardar DETALLES
  const items = ventaData.items || [];
  items.forEach(item => {
    const idDetalle = "DET-" + Utilities.getUuid().substring(0, 8).toUpperCase();
    shDetalle.appendRow([
      idDetalle,
      idVenta,
      item.idProducto,
      item.nombre,
      Number(item.cantidad),
      Number(item.precioUnitario),
      Number(item.subtotal),
      Number(item.costoUnitario || 0)
    ]);
  });
  // 3. Descontar STOCK (si viene de un pedido Confirmado, solo la diferencia con lo ya reservado)
  const reservado = pedido && pedido.estado === "Confirmado" ? mapaCantidades(pedido.items) : {};
  ajustarStock(ss, restarMapas(mapaCantidades(items), reservado), "VENTA", "Venta " + ticket, idVenta, fecha);
  // 3b. Cerrar el pedido de origen
  if (pedido) {
    escribirPedido(ss, { ...pedido, items, estado: "Cobrado", idVenta, fechaActualizacion: fecha });
  }
  // 4. Si fue venta a Crédito (Fiado), sumar saldo a Cliente
  if (ventaData.metodoPago === "Crédito" || ventaData.estadoPago === "Pendiente") {
    const clientesData = shClientes.getDataRange().getValues();
    const colIdCli = clientesData[0].indexOf("ID");
    const colDeudaCli = clientesData[0].indexOf("SALDO_DEUDA");
    if (colIdCli !== -1 && colDeudaCli !== -1) {
      for (let c = 1; c < clientesData.length; c++) {
        if (String(clientesData[c][colIdCli]) === String(ventaData.idCliente)) {
          const deudaActual = Number(clientesData[c][colDeudaCli]) || 0;
          shClientes.getRange(c + 1, colDeudaCli + 1).setValue(deudaActual + Number(ventaData.total));
          break;
        }
      }
    }
  }
  return { idVenta, ticket, total: ventaData.total, fecha, idPedido: pedido ? pedido.id : "" };
}
/**
 * Pedidos (Guardado: no toca stock / Confirmado: stock descontado / Cobrado / Anulado)
 */
const COLUMNAS_PEDIDO = ["ID", "NUMERO", "FECHA", "FECHA_ACTUALIZACION", "ID_CLIENTE", "NOMBRE_CLIENTE", "SUBTOTAL", "DESCUENTO", "IMPUESTO", "TOTAL", "ITEMS_JSON", "ESTADO", "ID_VENTA", "NOTAS"];
function filaAPedido(obj) {
  let items = [];
  try {
    items = JSON.parse(obj.itemsJson || "[]");
  } catch (e) { }
  const pedido = { ...obj, items };
  delete pedido.itemsJson;
  return pedido;
}
function pedidoAFila(p) {
  return [
    p.id,
    p.numero,
    p.fecha,
    p.fechaActualizacion,
    p.idCliente || "PUBLICO_GENERAL",
    p.nombreCliente || "Público General",
    Number(p.subtotal || 0),
    Number(p.descuento || 0),
    Number(p.impuesto || 0),
    Number(p.total || 0),
    JSON.stringify(p.items || []),
    p.estado || "Guardado",
    p.idVenta || "",
    p.notas || ""
  ];
}
function buscarFilaPedido(sh, id) {
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(id)) return { fila: i + 1, valores: data[i] };
  }
  return null;
}
function obtenerPedido(ss, id) {
  const encontrado = buscarFilaPedido(ss.getSheetByName(TABLAS.PEDIDOS), id);
  if (!encontrado) return null;
  const obj = {};
  COLUMNAS_PEDIDO.forEach((col, c) => {
    obj[col.toLowerCase().replace(/_([a-z])/g, g => g[1].toUpperCase())] = encontrado.valores[c];
  });
  return filaAPedido(obj);
}
function escribirPedido(ss, p) {
  const sh = ss.getSheetByName(TABLAS.PEDIDOS);
  const valores = pedidoAFila(p);
  const encontrado = buscarFilaPedido(sh, p.id);
  if (encontrado) sh.getRange(encontrado.fila, 1, 1, valores.length).setValues([valores]);
  else sh.appendRow(valores);
  return p;
}
function guardarOActualizarPedido(ss, data) {
  const ahora = new Date().toISOString();
  const anterior = data.id ? obtenerPedido(ss, data.id) : null;
  if (anterior && (anterior.estado === "Cobrado" || anterior.estado === "Anulado")) {
    throw new Error("El pedido " + anterior.numero + " ya está " + anterior.estado.toLowerCase() + " y no se puede editar");
  }
  const pedido = {
    ...data,
    id: anterior ? anterior.id : (data.id || "PED-" + Utilities.getUuid().substring(0, 8).toUpperCase()),
    numero: anterior ? anterior.numero : "PED-" + Math.floor(100000 + Math.random() * 900000),
    fecha: anterior ? anterior.fecha : ahora,
    fechaActualizacion: ahora,
    estado: anterior ? anterior.estado : "Guardado",
    idVenta: ""
  };
  // Pedido Confirmado editado: el stock se ajusta solo por la diferencia
  if (anterior && anterior.estado === "Confirmado") {
    const delta = restarMapas(mapaCantidades(pedido.items), mapaCantidades(anterior.items));
    ajustarStock(ss, delta, "AJUSTE_PEDIDO", "Edición pedido " + pedido.numero, pedido.id, ahora);
  }
  return escribirPedido(ss, pedido);
}
function confirmarPedido(ss, id) {
  const pedido = obtenerPedido(ss, id);
  if (!pedido) throw new Error("Pedido no encontrado: " + id);
  if (pedido.estado !== "Guardado") throw new Error("Solo se pueden confirmar pedidos en estado Guardado");
  const ahora = new Date().toISOString();
  ajustarStock(ss, mapaCantidades(pedido.items), "RESERVA_PEDIDO", "Pedido confirmado " + pedido.numero, pedido.id, ahora);
  return escribirPedido(ss, { ...pedido, estado: "Confirmado", fechaActualizacion: ahora });
}
function anularPedido(ss, id) {
  const pedido = obtenerPedido(ss, id);
  if (!pedido) throw new Error("Pedido no encontrado: " + id);
  if (pedido.estado === "Cobrado") throw new Error("Un pedido cobrado no se puede anular");
  const ahora = new Date().toISOString();
  if (pedido.estado === "Confirmado") {
    const devolucion = restarMapas({}, mapaCantidades(pedido.items));
    ajustarStock(ss, devolucion, "ANULACION_PEDIDO", "Pedido anulado " + pedido.numero, pedido.id, ahora);
  }
  return escribirPedido(ss, { ...pedido, estado: "Anulado", fechaActualizacion: ahora });
}
/**
 * Utilidades de stock: mapas { idProducto: cantidad } y descuento con Kardex
 */
function mapaCantidades(items) {
  const mapa = {};
  (items || []).forEach(it => {
    mapa[it.idProducto] = (mapa[it.idProducto] || 0) + Number(it.cantidad || 0);
  });
  return mapa;
}
function restarMapas(a, b) {
  const res = {};
  Object.keys({ ...a, ...b }).forEach(id => {
    const d = (a[id] || 0) - (b[id] || 0);
    if (d !== 0) res[id] = d;
  });
  return res;
}
// Descuenta delta[id] unidades de cada producto (negativo = devuelve) y registra el movimiento
function ajustarStock(ss, delta, tipo, motivo, idRef, fecha) {
  const ids = Object.keys(delta);
  if (ids.length === 0) return;
  const shProductos = ss.getSheetByName(TABLAS.PRODUCTOS);
  const shMovimientos = ss.getSheetByName(TABLAS.MOVIMIENTOS_STOCK);
  const productosData = shProductos.getDataRange().getValues();
  const colIdProd = productosData[0].indexOf("ID");
  const colStockProd = productosData[0].indexOf("STOCK");
  if (colIdProd === -1 || colStockProd === -1) return;
  ids.forEach(idProducto => {
    for (let r = 1; r < productosData.length; r++) {
      if (String(productosData[r][colIdProd]) === String(idProducto)) {
        const stockActual = Number(productosData[r][colStockProd]) || 0;
        const nuevoStock = stockActual - delta[idProducto];
        shProductos.getRange(r + 1, colStockProd + 1).setValue(nuevoStock);
        shMovimientos.appendRow([
          "MOV-" + Utilities.getUuid().substring(0, 8).toUpperCase(),
          fecha || new Date().toISOString(),
          idProducto,
          tipo,
          -delta[idProducto],
          stockActual,
          nuevoStock,
          motivo,
          idRef
        ]);
        break;
      }
    }
  });
}
/**
 * Guardar o Actualizar Producto
 */
function guardarOActualizarProducto(ss, prod) {
  const sh = ss.getSheetByName(TABLAS.PRODUCTOS);
  const data = sh.getDataRange().getValues();
  const encabezados = data[0];
  const idCol = 0;
  const colStock = encabezados.indexOf("STOCK");
  const colFecha = encabezados.indexOf("FECHA_CREACION");
  let filaEncontrada = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][idCol]) === String(prod.id)) {
      filaEncontrada = i + 1;
      break;
    }
  }
  const id = prod.id || "PRD-" + Utilities.getUuid().substring(0, 8).toUpperCase();
  let movimiento = null;
  if (filaEncontrada > 0) {
    const filaActual = data[filaEncontrada - 1];
    // La fecha de creación nunca se reemplaza en una edición
    if (colFecha !== -1 && filaActual[colFecha]) prod.fechaCreacion = filaActual[colFecha];
    // Registrar ajuste manual de stock en el Kardex
    const stockAnterior = colStock !== -1 ? Number(filaActual[colStock]) || 0 : 0;
    const stockNuevo = Number(prod.stock || 0);
    if (colStock !== -1 && stockNuevo !== stockAnterior) {
      movimiento = {
        tipo: "AJUSTE_MANUAL",
        cantidad: stockNuevo - stockAnterior,
        stockAnterior,
        stockNuevo
      };
      ss.getSheetByName(TABLAS.MOVIMIENTOS_STOCK).appendRow([
        "MOV-" + Utilities.getUuid().substring(0, 8).toUpperCase(),
        new Date().toISOString(),
        id,
        movimiento.tipo,
        movimiento.cantidad,
        stockAnterior,
        stockNuevo,
        prod.motivoAjuste || "Edición de producto",
        id
      ]);
    }
  }
  const filaValores = [
    id,
    prod.sku || "",
    prod.codigoBarras || "",
    prod.nombre,
    prod.descripcion || "",
    prod.categoria || "General",
    Number(prod.precioVenta || 0),
    Number(prod.precioCosto || 0),
    Number(prod.stock || 0),
    Number(prod.stockMinimo || 5),
    prod.unidad || "UND",
    prod.urlImagen || "",
    prod.activo !== undefined ? prod.activo : true,
    prod.fechaCreacion || new Date().toISOString()
  ];
  if (filaEncontrada > 0) {
    sh.getRange(filaEncontrada, 1, 1, filaValores.length).setValues([filaValores]);
  } else {
    sh.appendRow(filaValores);
  }
  delete prod.motivoAjuste;
  return { ...prod, id, fechaCreacion: filaValores[13], movimiento };
}
/**
 * Eliminar Producto (Borrado protegido: solo si no tiene ventas ni movimientos)
 */
function eliminarProducto(ss, idProducto) {
  const tieneHistorial = [TABLAS.DETALLE_VENTAS, TABLAS.MOVIMIENTOS_STOCK].some(nombre => {
    const filas = ss.getSheetByName(nombre).getDataRange().getValues();
    const colProd = filas[0].indexOf("ID_PRODUCTO");
    return colProd !== -1 && filas.slice(1).some(f => String(f[colProd]) === String(idProducto));
  });
  if (tieneHistorial) {
    return { success: false, id: idProducto, motivo: "CON_HISTORIAL" };
  }
  const sh = ss.getSheetByName(TABLAS.PRODUCTOS);
  const data = sh.getDataRange().getValues();
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(idProducto)) {
      sh.deleteRow(i + 1);
      return { success: true, id: idProducto };
    }
  }
  return { success: false, id: idProducto, motivo: "NO_ENCONTRADO" };
}
/**
 * Guardar o Actualizar Categoría (nombre único; la fila se escribe por nombre de columna)
 */
function guardarOActualizarCategoria(ss, cat) {
  const sh = ss.getSheetByName(TABLAS.CATEGORIAS);
  const data = sh.getDataRange().getValues();
  const encabezados = data[0];
  const colId = encabezados.indexOf("ID");
  const colNombre = encabezados.indexOf("NOMBRE");
  const nombre = String(cat.nombre || "").trim();
  if (!nombre) throw new Error("El nombre de la categoría es obligatorio");
  let fila = -1;
  for (let i = 1; i < data.length; i++) {
    const mismoId = cat.id && String(data[i][colId]) === String(cat.id);
    if (mismoId) {
      fila = i + 1;
    } else if (String(data[i][colNombre]).trim().toLowerCase() === nombre.toLowerCase()) {
      throw new Error("Ya existe una categoría llamada " + data[i][colNombre]);
    }
  }
  const categoria = {
    id: cat.id || "CAT-" + Utilities.getUuid().substring(0, 8).toUpperCase(),
    nombre,
    color: cat.color || "#64748b",
    icono: cat.icono || "label",
    urlIcono: cat.urlIcono || ""
  };
  const porColumna = { ID: categoria.id, NOMBRE: categoria.nombre, COLOR: categoria.color, ICONO: categoria.icono, URL_ICONO: categoria.urlIcono };
  const valores = encabezados.map((h, c) => (h in porColumna ? porColumna[h] : (fila > 0 ? data[fila - 1][c] : "")));
  if (fila > 0) {
    sh.getRange(fila, 1, 1, valores.length).setValues([valores]);
  } else {
    sh.appendRow(valores);
  }
  return categoria;
}
/**
 * Eliminar Categoría (Borrado protegido: solo si ningún producto la usa)
 */
function eliminarCategoria(ss, idCategoria) {
  const sh = ss.getSheetByName(TABLAS.CATEGORIAS);
  const data = sh.getDataRange().getValues();
  const colId = data[0].indexOf("ID");
  const colNombre = data[0].indexOf("NOMBRE");
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][colId]) === String(idCategoria)) {
      const nombre = String(data[i][colNombre]);
      const prods = ss.getSheetByName(TABLAS.PRODUCTOS).getDataRange().getValues();
      const colCat = prods[0].indexOf("CATEGORIA");
      const enUso = colCat === -1 ? 0 : prods.slice(1).filter(f => String(f[colCat]) === nombre).length;
      if (enUso > 0) {
        return { success: false, id: idCategoria, motivo: "CON_PRODUCTOS", productos: enUso };
      }
      sh.deleteRow(i + 1);
      return { success: true, id: idCategoria };
    }
  }
  return { success: false, id: idCategoria, motivo: "NO_ENCONTRADO" };
}
/**
 * Guardar o Actualizar Cliente
 */
function guardarOActualizarCliente(ss, cli) {
  const sh = ss.getSheetByName(TABLAS.CLIENTES);
  const data = sh.getDataRange().getValues();
  let fila = -1;
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][0]) === String(cli.id)) {
      fila = i + 1;
      break;
    }
  }
  const valores = [
    cli.id || "CLI-" + Utilities.getUuid().substring(0, 8).toUpperCase(),
    cli.nombre,
    cli.documento || "",
    cli.telefono || "",
    cli.email || "",
    cli.direccion || "",
    Number(cli.limiteCredito || 0),
    Number(cli.saldoDeuda || 0),
    cli.fechaRegistro || new Date().toISOString()
  ];
  if (fila > 0) {
    sh.getRange(fila, 1, 1, valores.length).setValues([valores]);
  } else {
    sh.appendRow(valores);
  }
  return cli;
}
/**
 * Actualizar Estado de Pedido (Pendiente, En Preparación, Listo, Entregado, Cancelado)
 */
function actualizarEstadoPedido(ss, idVenta, nuevoEstado) {
  const sh = ss.getSheetByName(TABLAS.VENTAS);
  const data = sh.getDataRange().getValues();
  const colId = 0;
  const colEstadoEntrega = 13; // ESTADO_ENTREGA
  for (let i = 1; i < data.length; i++) {
    if (String(data[i][colId]) === String(idVenta)) {
      sh.getRange(i + 1, colEstadoEntrega + 1).setValue(nuevoEstado);
      return { idVenta, nuevoEstado };
    }
  }
  throw new Error("Pedido no encontrado: " + idVenta);
}
/**
 * Registrar Gasto
 */
function registrarGasto(ss, gasto) {
  const sh = ss.getSheetByName(TABLAS.GASTOS);
  const idGasto = gasto.id || "EXP-" + Utilities.getUuid().substring(0, 8).toUpperCase();
  sh.appendRow([
    idGasto,
    gasto.fecha || new Date().toISOString(),
    gasto.categoria || "Operativo",
    gasto.descripcion || "",
    Number(gasto.monto || 0),
    gasto.metodoPago || "Efectivo",
    gasto.proveedor || "",
    gasto.comprobanteUrl || "",
    gasto.registradoPor || "Admin"
  ]);
  return { idGasto, ...gasto };
}
/**
 * Actualizar Configuración del Negocio
 */
function actualizarConfiguracion(ss, conf) {
  const sh = ss.getSheetByName(TABLAS.CONFIG);
  sh.clearContents();
  sh.appendRow(["PARAMETRO", "VALOR"]);
  
  Object.keys(conf).forEach(k => {
    sh.appendRow([k, conf[k]]);
  });
  return conf;
}
/**
 * Subida de Imágenes a Google Drive con enlace público directo
 */
function subirImagenADrive(base64Data, nombreArchivo) {
  let carpeta = DriveApp.getRootFolder();
  if (ID_CARPETA_DRIVE && ID_CARPETA_DRIVE.trim() !== "") {
    try {
      carpeta = DriveApp.getFolderById(ID_CARPETA_DRIVE);
    } catch (e) {
      carpeta = DriveApp.getRootFolder();
    }
  }
  const partes = base64Data.split(",");
  const contentType = partes[0].match(/:(.*?);/)[1];
  const decodeBytes = Utilities.base64Decode(partes[1]);
  const blob = Utilities.newBlob(decodeBytes, contentType, nombreArchivo || "img_" + Date.now());
  const archivo = carpeta.createFile(blob);
  archivo.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
  
  const fileId = archivo.getId();
  const urlDirecta = "https://lh3.googleusercontent.com/d/" + fileId;
  return {
    fileId: fileId,
    urlDrive: archivo.getUrl(),
    urlDirecta: urlDirecta
  };
}
/**
 * Inicialización Automática de Pestañas con Encabezados y Estilos
 */
function inicializarTodasLasPestanas() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const esquema = [
    {
      nombre: TABLAS.CONFIG,
      headers: ["PARAMETRO", "VALOR"],
      defaults: [
        ["NOMBRE_TIENDA", "SUPRE POS Store"],
        ["MONEDA_SIMBOLO", "$"],
        ["IMPUESTO_PORCENTAJE", "0"],
        ["TELEFONO_CONTACTO", "+1234567890"],
        ["DIRECCION", "Calle Principal 123"],
        ["PIE_TICKET", "¡Gracias por su compra en SUPRE POS!"]
      ]
    },
    {
      nombre: TABLAS.PRODUCTOS,
      headers: ["ID", "SKU", "CODIGO_BARRAS", "NOMBRE", "DESCRIPCION", "CATEGORIA", "PRECIO_VENTA", "PRECIO_COSTO", "STOCK", "STOCK_MINIMO", "UNIDAD", "URL_IMAGEN", "ACTIVO", "FECHA_CREACION"]
    },
    {
      nombre: TABLAS.CATEGORIAS,
      headers: ["ID", "NOMBRE", "COLOR", "ICONO", "URL_ICONO"],
      defaults: [
        ["CAT-1", "Bebidas", "#0051d5", "local_cafe", ""],
        ["CAT-2", "Alimentos", "#059669", "restaurant", ""],
        ["CAT-3", "Snacks", "#d97706", "fastfood", ""],
        ["CAT-4", "Servicios", "#6366f1", "room_service", ""]
      ]
    },
    {
      nombre: TABLAS.CLIENTES,
      headers: ["ID", "NOMBRE", "DOCUMENTO", "TELEFONO", "EMAIL", "DIRECCION", "LIMITE_CREDITO", "SALDO_DEUDA", "FECHA_REGISTRO"]
    },
    {
      nombre: TABLAS.VENTAS,
      headers: ["ID", "TICKET", "FECHA", "ID_CLIENTE", "NOMBRE_CLIENTE", "METODO_PAGO", "SUBTOTAL", "DESCUENTO", "IMPUESTO", "TOTAL", "MONTO_RECIBIDO", "CAMBIO", "ESTADO_PAGO", "ESTADO_ENTREGA", "VENDEDOR", "NOTAS"]
    },
    {
      nombre: TABLAS.DETALLE_VENTAS,
      headers: ["ID", "ID_VENTA", "ID_PRODUCTO", "NOMBRE_PRODUCTO", "CANTIDAD", "PRECIO_UNITARIO", "SUBTOTAL", "COSTO_UNITARIO"]
    },
    {
      nombre: TABLAS.GASTOS,
      headers: ["ID", "FECHA", "CATEGORIA", "DESCRIPCION", "MONTO", "METODO_PAGO", "PROVEEDOR", "COMPROBANTE_URL", "REGISTRADO_POR"]
    },
    {
      nombre: TABLAS.MOVIMIENTOS_STOCK,
      headers: ["ID", "FECHA", "ID_PRODUCTO", "TIPO", "CANTIDAD", "STOCK_ANTERIOR", "STOCK_NUEVO", "MOTIVO", "ID_REFERENCIA"]
    },
    {
      nombre: TABLAS.PEDIDOS,
      headers: COLUMNAS_PEDIDO
    }
  ];
  esquema.forEach(pestana => {
    let sh = ss.getSheetByName(pestana.nombre);
    if (!sh) {
      sh = ss.insertSheet(pestana.nombre);
      sh.appendRow(pestana.headers);
      
      // Estilo de cabecera profesional
      const cabecera = sh.getRange(1, 1, 1, pestana.headers.length);
      cabecera.setBackground("#050a18");
      cabecera.setFontColor("#ffffff");
      cabecera.setFontWeight("bold");
      sh.setFrozenRows(1);
      if (pestana.defaults && pestana.defaults.length > 0) {
        pestana.defaults.forEach(fila => sh.appendRow(fila));
      }
    } else {
      asegurarColumnas(sh, pestana.headers);
    }
  });
}
/**
 * Migración: agrega al final las columnas nuevas que falten en una pestaña existente
 */
function asegurarColumnas(sh, headers) {
  const ultimaCol = sh.getLastColumn();
  const actuales = ultimaCol > 0 ? sh.getRange(1, 1, 1, ultimaCol).getValues()[0] : [];
  const faltantes = headers.filter(h => actuales.indexOf(h) === -1);
  if (faltantes.length === 0) return;
  const rango = sh.getRange(1, ultimaCol + 1, 1, faltantes.length);
  rango.setValues([faltantes]);
  rango.setBackground("#050a18");
  rango.setFontColor("#ffffff");
  rango.setFontWeight("bold");
}
/**
 * Utilidades de Transformación
 */
function sheetToObjects(sheet) {
  if (!sheet) return [];
  const values = sheet.getDataRange().getValues();
  if (values.length <= 1) return [];
  const headers = values[0];
  const results = [];
  for (let r = 1; r < values.length; r++) {
    const row = values[r];
    const obj = {};
    for (let c = 0; c < headers.length; c++) {
      let key = headers[c];
      // Convertir a camelCase sencillo
      key = key.toLowerCase().replace(/_([a-z])/g, (g) => g[1].toUpperCase());
      obj[key] = row[c];
    }
    results.push(obj);
  }
  return results;
}
function jsonResponse(data) {
  return ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
}