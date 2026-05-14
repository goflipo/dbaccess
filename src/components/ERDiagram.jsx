import React, { useState, useEffect, useCallback, useMemo } from 'react'
import { ReactFlow, Controls, Background, applyNodeChanges, applyEdgeChanges, Handle, Position, MarkerType, getNodesBounds, getViewportForBounds, MiniMap } from '@xyflow/react'
import dagre from 'dagre'
import { toPng, toSvg } from 'html-to-image'
import '@xyflow/react/dist/style.css'
import './ERDiagram.css'

const getColor = (str) => {
  let hash = 0;
  for (let i = 0; i < str.length; i++) {
    hash = str.charCodeAt(i) + ((hash << 5) - hash);
  }
  const hue = Math.abs(hash % 360);
  return `hsl(${hue}, 65%, 55%)`;
}

const getLayoutedElements = (nodes, edges) => {
  const dagreGraph = new dagre.graphlib.Graph();
  dagreGraph.setDefaultEdgeLabel(() => ({}));
  dagreGraph.setGraph({ rankdir: 'LR', align: 'UL', nodesep: 80, ranksep: 280 });

  nodes.forEach((node) => {
    const height = 44 + (node.data.columns.length * 26);
    dagreGraph.setNode(node.id, { width: 280, height });
  });

  edges.forEach((edge) => {
    dagreGraph.setEdge(edge.source, edge.target);
  });

  dagre.layout(dagreGraph);

  const layoutedNodes = nodes.map((node) => {
    const nodeWithPosition = dagreGraph.node(node.id);
    const height = 44 + (node.data.columns.length * 26);
    return {
      ...node,
      position: {
        x: nodeWithPosition.x - 280 / 2,
        y: nodeWithPosition.y - height / 2,
      },
    };
  });

  return { nodes: layoutedNodes, edges };
};

// ── FK Badge inside column row ──────────────────────────────────────────────
const FK_ICON = (
  <svg width="9" height="9" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.5" style={{ flexShrink: 0 }}>
    <path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/>
    <path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/>
  </svg>
)

const TableNode = ({ data, selected }) => {
  const color = useMemo(() => getColor(data.name), [data.name]);

  return (
    <div
      className={`erd-table ${selected ? 'selected' : ''}`}
      style={{ borderTop: `3px solid ${color}` }}
    >
      {/* Left handle for the whole node — target of FKs */}
      <Handle
        type="target"
        position={Position.Left}
        id="target-left"
        className="erd-handle erd-handle-left"
      />

      <div className="erd-table-header" style={{ borderTopColor: color }}>
        <div className="erd-table-header-icon" style={{ background: color + '22', border: `1px solid ${color}55` }}>
          <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth="2">
            <rect x="2" y="2" width="20" height="20" rx="2"/>
            <path d="M2 8h20M8 2v20"/>
          </svg>
        </div>
        <span className="erd-table-name">{data.name}</span>
        <span className="erd-table-schema">{data.schema}</span>
      </div>

      <div className="erd-table-columns">
        {data.columns.map((col, idx) => {
          const isFK = data.fkColumns && data.fkColumns.has(col.name);
          const isPK = data.pkColumns && data.pkColumns.has(col.name);
          const isActive = data.activeColumns && data.activeColumns.has(col.name);
          return (
            <div
              key={col.name}
              className={`erd-column ${isActive ? 'active' : ''} ${isPK ? 'pk-col' : ''} ${isFK ? 'fk-col' : ''}`}
            >
              <div className="erd-col-left">
                {isPK && (
                  <svg className="erd-col-icon pk-icon" width="9" height="9" viewBox="0 0 24 24" fill="currentColor">
                    <path d="M17 11C15.89 11 15 11.89 15 13C15 14.11 15.89 15 17 15C18.11 15 19 14.11 19 13C19 11.89 18.11 11 17 11M17 9C19.21 9 21 10.79 21 13C21 15.21 19.21 17 17 17C14.79 17 13 15.21 13 13C13 12.03 13.37 11.16 14 10.54L5 3H3V5L7 9L9 7L11 9L9 11L11 13H15.04C15.58 10.73 17.58 9 17 9Z"/>
                  </svg>
                )}
                {isFK && !isPK && (
                  <span className="erd-col-icon fk-icon" style={{ color: '#f7c948' }}>{FK_ICON}</span>
                )}
                <span className="erd-col-name">{col.name}</span>
              </div>
              <span className="erd-col-type">{(col.type || '').replace('character varying', 'varchar').replace('timestamp without time zone', 'timestamp')}</span>
            </div>
          );
        })}
      </div>

      {/* Right handle for the whole node — source of FKs */}
      <Handle
        type="source"
        position={Position.Right}
        id="source-right"
        className="erd-handle erd-handle-right"
      />
    </div>
  )
}

export default function ERDiagram({ connectionId, dbAccess }) {
  const [nodes, setNodes] = useState([])
  const [edges, setEdges] = useState([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState(null)
  const [selectedNode, setSelectedNode] = useState(null)
  const [rfInstance, setRfInstance] = useState(null)
  const [exportMenuOpen, setExportMenuOpen] = useState(false)
  const [isExporting, setIsExporting] = useState(false)
  const [fkCount, setFkCount] = useState(0)

  const nodeTypes = useMemo(() => ({ table: TableNode }), [])

  useEffect(() => {
    let mounted = true
    const loadSchema = async () => {
      try {
        setLoading(true)
        setError(null)
        const result = await dbAccess.getSchemaFull(connectionId)
        if (!mounted) return

        if (result.success) {
          const { tables, foreignKeys } = result.data
          console.log(`[ERDiagram] Tables: ${tables.length}, FKs: ${foreignKeys.length}`)
          console.log('[ERDiagram] Sample FKs:', foreignKeys.slice(0, 3))

          // Build per-table FK column sets (so we can highlight them in the node)
          const fkColsByTable = {}
          const pkColsByTable = {}
          foreignKeys.forEach(fk => {
            if (!fkColsByTable[fk.sourceTable]) fkColsByTable[fk.sourceTable] = new Set()
            fkColsByTable[fk.sourceTable].add(fk.sourceColumn)
          })

          const initialNodes = tables.map((t) => ({
            id: t.fullName,
            type: 'table',
            position: { x: 0, y: 0 },
            data: {
              schema: t.schema,
              name: t.name,
              columns: t.columns,
              fkColumns: fkColsByTable[t.fullName] || new Set(),
              pkColumns: pkColsByTable[t.fullName] || new Set(),
              activeColumns: new Set(),
            },
            dragHandle: '.erd-table-header',
          }))

          // Build edges — use single node-level handles (not per-column) for reliability
          const initialEdges = foreignKeys.map((fk, i) => ({
            id: `fk-${i}-${fk.sourceTable}.${fk.sourceColumn}->${fk.targetTable}.${fk.targetColumn}`,
            source: fk.sourceTable,
            target: fk.targetTable,
            sourceHandle: 'source-right',
            targetHandle: 'target-left',
            type: 'smoothstep',
            animated: false,
            label: `${fk.sourceColumn} → ${fk.targetColumn}`,
            labelStyle: { fill: '#aab0c0', fontWeight: 600, fontSize: 10, fontFamily: 'monospace' },
            labelBgStyle: { fill: '#1a2035', stroke: '#2e3a55', strokeWidth: 1 },
            labelBgPadding: [6, 3],
            labelBgBorderRadius: 4,
            style: { stroke: '#5b8dee', strokeWidth: 2.5 },
            markerEnd: {
              type: MarkerType.ArrowClosed,
              width: 14,
              height: 14,
              color: '#5b8dee',
            },
            markerStart: {
              type: MarkerType.Arrow,
              width: 10,
              height: 10,
              color: '#5b8dee',
            },
          }))

          setFkCount(initialEdges.length)

          const { nodes: layoutedNodes, edges: layoutedEdges } = getLayoutedElements(initialNodes, initialEdges)
          setNodes(layoutedNodes)
          setEdges(layoutedEdges)
        } else {
          console.error('[ERDiagram] Failed to fetch schema:', result.error)
          setError(result.error)
        }
      } catch (err) {
        if (mounted) {
          console.error('[ERDiagram] Exception:', err)
          setError(err.message)
        }
      } finally {
        if (mounted) setLoading(false)
      }
    }
    loadSchema()
    return () => { mounted = false }
  }, [connectionId, dbAccess])

  const onNodesChange = useCallback((changes) => setNodes((nds) => applyNodeChanges(changes, nds)), [])
  const onEdgesChange = useCallback((changes) => setEdges((eds) => applyEdgeChanges(changes, eds)), [])

  const onNodeClick = useCallback((_, node) => {
    setSelectedNode(prev => prev === node.id ? null : node.id)
  }, [])

  const onPaneClick = useCallback(() => {
    setSelectedNode(null)
  }, [])

  // Auto-zoom to selected node and its connected nodes
  useEffect(() => {
    if (!rfInstance) return

    if (!selectedNode) {
      // Re-fit the entire view if deselected
      rfInstance.fitView({ padding: 0.15, duration: 800 })
      return
    }

    const relatedNodeIds = new Set([selectedNode])
    edges.forEach(edge => {
      if (edge.source === selectedNode) relatedNodeIds.add(edge.target)
      if (edge.target === selectedNode) relatedNodeIds.add(edge.source)
    })

    const relatedNodes = nodes.filter(n => relatedNodeIds.has(n.id))
    if (relatedNodes.length > 0) {
      rfInstance.fitView({ nodes: relatedNodes, padding: 0.2, duration: 800 })
    }
  }, [selectedNode, nodes, edges, rfInstance])

  // Highlight connected nodes when one is selected
  const displayNodes = useMemo(() => {
    return nodes.map(node => {
      if (!selectedNode) {
        return {
          ...node,
          data: { ...node.data, activeColumns: new Set() },
          style: { opacity: 1, filter: 'none', transition: 'all 0.3s ease' }
        }
      }

      const isSelected = node.id === selectedNode
      const activeColumns = new Set()
      let isRelated = isSelected

      edges.forEach(edge => {
        if (edge.source === selectedNode && edge.target === node.id) {
          isRelated = true
          // extract column from label
          const match = edge.label?.match(/^(.+?) →/)
          if (match) activeColumns.add(match[1].trim())
        }
        if (edge.target === selectedNode && edge.source === node.id) {
          isRelated = true
          const match = edge.label?.match(/→ (.+)$/)
          if (match) activeColumns.add(match[1].trim())
        }
      })

      const isDimmed = !isRelated
      return {
        ...node,
        data: { ...node.data, activeColumns },
        style: {
          opacity: isDimmed ? 0.12 : 1,
          filter: isDimmed ? 'blur(2px) grayscale(0.7)' : 'none',
          transition: 'all 0.35s ease',
          zIndex: isSelected ? 10 : (isRelated ? 5 : 0),
        }
      }
    })
  }, [nodes, edges, selectedNode])

  const displayEdges = useMemo(() => {
    return edges.map(edge => {
      const isActive = selectedNode && (edge.source === selectedNode || edge.target === selectedNode)
      const isDimmed = selectedNode && !isActive

      return {
        ...edge,
        style: {
          stroke: isActive ? '#3dd68c' : (isDimmed ? '#2a3347' : '#5b8dee'),
          strokeWidth: isActive ? 3.5 : (isDimmed ? 1 : 2.5),
          opacity: isDimmed ? 0.15 : 1,
          filter: isActive ? 'drop-shadow(0 0 6px #3dd68c88)' : 'none',
          transition: 'all 0.3s ease',
        },
        markerEnd: {
          type: MarkerType.ArrowClosed,
          width: 14,
          height: 14,
          color: isActive ? '#3dd68c' : (isDimmed ? '#2a3347' : '#5b8dee'),
        },
        markerStart: {
          type: MarkerType.Arrow,
          width: 10,
          height: 10,
          color: isActive ? '#3dd68c' : (isDimmed ? '#2a3347' : '#5b8dee'),
        },
        labelStyle: {
          ...edge.labelStyle,
          opacity: isDimmed ? 0 : isActive ? 1 : 0.7,
          fill: isActive ? '#3dd68c' : '#aab0c0',
        },
        labelBgStyle: {
          ...edge.labelBgStyle,
          opacity: isDimmed ? 0 : 1,
        },
        animated: isActive,
        zIndex: isActive ? 100 : 1,
      }
    })
  }, [edges, selectedNode])

  if (loading) return (
    <div className="erd-container erd-center">
      <div className="erd-spinner"></div>
      <div style={{ marginTop: 14, color: 'var(--text-secondary)', fontSize: 14 }}>Generating ER Diagram...</div>
    </div>
  )

  if (error) return (
    <div className="erd-container erd-center" style={{ color: 'var(--accent-red)', gap: 12, flexDirection: 'column' }}>
      <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><circle cx="12" cy="12" r="10"/><path d="M15 9l-6 6M9 9l6 6"/></svg>
      <span>Failed to load schema: {error}</span>
    </div>
  )

  if (nodes.length === 0) return (
    <div className="erd-container erd-center" style={{ color: 'var(--text-tertiary)' }}>
      No tables found in this database.
    </div>
  )

  // ── Export helpers ──────────────────────────────────────────────────────────
  const exportToImage = async (format) => {
    setExportMenuOpen(false)
    const nodeEl = document.querySelector('.react-flow__viewport')
    if (!nodeEl || !rfInstance) return
    setIsExporting(true)
    await new Promise(r => setTimeout(r, 60))
    try {
      const bounds = getNodesBounds(nodes)
      const padded = { x: bounds.x - 300, y: bounds.y - 300, width: bounds.width + 600, height: bounds.height + 600 }
      const transform = getViewportForBounds(padded, padded.width, padded.height, 0.1, 2)
      const cfg = {
        backgroundColor: '#0d1017', width: padded.width, height: padded.height,
        style: { width: padded.width, height: padded.height, transform: `translate(${transform.x}px,${transform.y}px) scale(${transform.zoom})` }
      }
      if (format === 'svg') {
        const url = await toSvg(nodeEl, cfg)
        const svg = decodeURIComponent(url.replace(/data:image\/svg\+xml;charset=utf-8,/, ''))
        await dbAccess.saveRawFile(svg, 'schema_export.svg', [{ name: 'SVG Image', extensions: ['svg'] }], false)
      } else {
        const url = await toPng(nodeEl, cfg)
        await dbAccess.saveRawFile(url, 'schema_export.png', [{ name: 'PNG Image', extensions: ['png'] }], true)
      }
    } catch (err) {
      alert('Export failed: ' + err.message)
    } finally {
      setIsExporting(false)
    }
  }

  const exportToDrawio = async () => {
    setExportMenuOpen(false); setIsExporting(true)
    await new Promise(r => setTimeout(r, 60))
    let xml = `<mxfile><diagram id="db-schema" name="Schema"><mxGraphModel><root><mxCell id="0"/><mxCell id="1" parent="0"/>`
    nodes.forEach(n => {
      const w = 300, h = 44 + n.data.columns.length * 26
      xml += `<mxCell id="${n.id}" value="${n.data.name}" style="swimlane;" vertex="1" parent="1"><mxGeometry x="${n.position.x}" y="${n.position.y}" width="${w}" height="${h}" as="geometry"/></mxCell>`
      n.data.columns.forEach((c, i) => {
        xml += `<mxCell id="${n.id}-${c.name}" value="${c.name} : ${c.type}" style="text;strokeColor=none;fillColor=none;align=left;" vertex="1" parent="${n.id}"><mxGeometry y="${30 + i * 26}" width="${w}" height="26" as="geometry"/></mxCell>`
      })
    })
    edges.forEach((e, i) => {
      xml += `<mxCell id="edge-${i}" style="edgeStyle=orthogonalEdgeStyle;" edge="1" parent="1" source="${e.source}" target="${e.target}"><mxGeometry relative="1" as="geometry"/></mxCell>`
    })
    xml += `</root></mxGraphModel></diagram></mxfile>`
    try { await dbAccess.saveRawFile(xml, 'schema_export.drawio', [{ name: 'Draw.io', extensions: ['drawio'] }], false) }
    finally { setIsExporting(false) }
  }

  const exportToSql = async () => {
    setExportMenuOpen(false); setIsExporting(true)
    await new Promise(r => setTimeout(r, 60))
    let sql = `-- Schema Export\n\n`
    nodes.forEach(n => {
      sql += `CREATE TABLE ${n.data.schema}.${n.data.name} (\n${n.data.columns.map(c => `  ${c.name} ${c.type}`).join(',\n')}\n);\n\n`
    })
    if (edges.length > 0) {
      sql += `-- Foreign Keys\n\n`
      edges.forEach(e => {
        const [sCol, tCol] = (e.label || '').split(' → ')
        const s = nodes.find(n => n.id === e.source)?.data
        const t = nodes.find(n => n.id === e.target)?.data
        if (s && t && sCol && tCol) sql += `ALTER TABLE ${s.schema}.${s.name} ADD CONSTRAINT fk_${s.name}_${sCol?.trim()} FOREIGN KEY (${sCol?.trim()}) REFERENCES ${t.schema}.${t.name} (${tCol?.trim()});\n`
      })
    }
    try { await dbAccess.saveRawFile(sql, 'schema_export.sql', [{ name: 'SQL', extensions: ['sql'] }], false) }
    finally { setIsExporting(false) }
  }

  const exportToHtml = async () => {
    setExportMenuOpen(false); setIsExporting(true)
    await new Promise(r => setTimeout(r, 60))
    let html = `<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8"><title>DB Schema Docs</title><style>body{font-family:system-ui,sans-serif;background:#f9fafb;color:#111;padding:40px;margin:0}h1{font-size:28px;margin-bottom:4px}.meta{color:#6b7280;margin-bottom:32px;font-size:14px}.tbl{background:white;border:1px solid #e5e7eb;border-radius:8px;margin-bottom:28px;overflow:hidden}th{background:#f3f4f6;padding:10px 16px;font-size:11px;text-transform:uppercase;letter-spacing:.05em;color:#6b7280;text-align:left}td{padding:10px 16px;border-bottom:1px solid #e5e7eb}tr:last-child td{border:0}.cn{font-weight:600}.ct{color:#2563eb;font-family:monospace;font-size:12px}.fk{display:inline-block;padding:2px 8px;font-size:11px;background:#dbeafe;color:#1d4ed8;border-radius:99px}</style></head><body><h1>Database Schema</h1><div class="meta">Generated by DB Access</div>`
    nodes.forEach(n => {
      html += `<div class="tbl"><table><thead><tr><th>${n.data.name} <span style="font-weight:400;text-transform:none;letter-spacing:0;color:#9ca3af">${n.data.schema}</span></th><th>Type</th><th>FK</th></tr></thead><tbody>`
      n.data.columns.forEach(c => {
        const fks = edges.filter(e => e.source === n.id && e.label?.startsWith(c.name + ' →'))
        const fkHtml = fks.map(fk => { const [, tCol] = (fk.label || '').split(' → '); return `<span class="fk">→ ${nodes.find(t => t.id === fk.target)?.data.name || fk.target}.${tCol?.trim()}</span>` }).join(' ')
        html += `<tr><td class="cn">${c.name}</td><td class="ct">${c.type}</td><td>${fkHtml}</td></tr>`
      })
      html += `</tbody></table></div>`
    })
    html += `</body></html>`
    try { await dbAccess.saveRawFile(html, 'schema_documentation.html', [{ name: 'HTML', extensions: ['html'] }], false) }
    finally { setIsExporting(false) }
  }

  return (
    <div className="erd-container">
      <ReactFlow
        nodes={displayNodes}
        edges={displayEdges}
        onNodesChange={onNodesChange}
        onEdgesChange={onEdgesChange}
        onNodeClick={onNodeClick}
        onPaneClick={onPaneClick}
        onInit={setRfInstance}
        nodeTypes={nodeTypes}
        fitView
        fitViewOptions={{ padding: 0.15 }}
        minZoom={0.04}
        maxZoom={8}
        defaultEdgeOptions={{
          type: 'smoothstep',
          style: { stroke: '#5b8dee', strokeWidth: 2.5 },
          markerEnd: { type: MarkerType.ArrowClosed, width: 14, height: 14, color: '#5b8dee' },
        }}
        connectionLineStyle={{ stroke: '#5b8dee', strokeWidth: 2 }}
        attributionPosition="bottom-right"
        className="dark-theme-flow"
        proOptions={{ hideAttribution: true }}
      >
        <Background gap={20} size={1} color="#1e2535" />
        <Controls showInteractive={false} />
        <MiniMap
          nodeColor={(n) => getColor(n.data?.name || '')}
          nodeStrokeWidth={2}
          maskColor="rgba(0,0,0,0.5)"
          style={{ background: '#111720', border: '1px solid #1e2a40' }}
        />
      </ReactFlow>

      {/* Stats + Export controls */}
      <div className="erd-export-controls">
        <div className="erd-stats-bar">
          <span>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: 'middle' }}><rect x="2" y="2" width="20" height="20" rx="2"/><path d="M2 8h20M8 2v20"/></svg>
            {' '}{nodes.length} tables
          </span>
          <span style={{ color: fkCount > 0 ? '#5b8dee' : 'inherit' }}>
            <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: 'middle' }}><path d="M10 13a5 5 0 007.54.54l3-3a5 5 0 00-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 00-7.54-.54l-3 3a5 5 0 007.07 7.07l1.71-1.71"/></svg>
            {' '}{fkCount} FK relations
          </span>
          {selectedNode && (
            <span style={{ color: '#3dd68c' }}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ verticalAlign: 'middle' }}><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
              {' '}{selectedNode.split('.').pop()} (click canvas to deselect)
            </span>
          )}
        </div>
        <button className="btn-primary" onClick={() => setExportMenuOpen(!exportMenuOpen)}>
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4M7 10l5 5 5-5M12 15V3"/></svg>
          Export
        </button>
        {exportMenuOpen && (
          <div className="erd-export-menu">
            <button onClick={() => exportToImage('png')}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><path d="M21 15l-5-5L5 21"/></svg>
              Export as PNG
            </button>
            <button onClick={() => exportToImage('svg')}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><rect x="3" y="3" width="18" height="18" rx="2"/></svg>
              Export as SVG
            </button>
            <button onClick={() => exportToDrawio()}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><path d="M3 5a2 2 0 012-2h14a2 2 0 012 2v14a2 2 0 01-2 2H5a2 2 0 01-2-2V5z"/></svg>
              Export to Draw.io
            </button>
            <button onClick={() => exportToSql()}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><ellipse cx="12" cy="5" rx="9" ry="3"/><path d="M3 5v14c0 1.66 4.03 3 9 3s9-1.34 9-3V5"/></svg>
              Export as SQL Script
            </button>
            <button onClick={() => exportToHtml()}>
              <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2"><polyline points="16 18 22 12 16 6"/><polyline points="8 6 2 12 8 18"/></svg>
              Export as HTML Docs
            </button>
          </div>
        )}
      </div>

      {isExporting && (
        <div className="erd-export-overlay">
          <div className="erd-spinner" style={{ width: 40, height: 40, borderTopColor: 'var(--accent-green)' }}></div>
          <div style={{ color: 'var(--text-primary)', fontWeight: 600, fontSize: 16, marginTop: 16 }}>Generating Export...</div>
          <div style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 6 }}>Please wait</div>
        </div>
      )}
    </div>
  )
}
