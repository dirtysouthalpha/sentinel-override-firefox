// background/knowledge-graph.js
// v7.0 Intelligence System - Knowledge Graph
// Maintains a knowledge graph for semantic understanding and contradiction detection

import { getErrorMessage } from './error-utils.js';

const STORAGE_KEY = 'sentinel_knowledge_graph';
const MAX_NODES = 10000;
const MAX_EDGES = 50000;

/**
 * Knowledge Graph class for storing and querying semantic relationships
 */
class KnowledgeGraph {
  constructor() {
    this.nodes = new Map(); // nodeId → node object
    this.edges = new Map(); // edgeId → edge object
    this.adjacencyList = new Map(); // nodeId → Set of connected nodeIds
    this.edgeRelationIndex = new Map(); // sourceId → Map<targetId, relation>
    this._loaded = false;
  }

  /**
   * Initialize or load the knowledge graph from storage
   */
  async init() {
    if (this._loaded) return;

    try {
      const result = await chrome.storage.local.get([STORAGE_KEY]);
      if (result[STORAGE_KEY]) {
        const data = result[STORAGE_KEY];
        
        // Reconstruct Maps
        this.nodes = new Map(Object.entries(data.nodes || {}));
        this.edges = new Map(Object.entries(data.edges || {}));
        this.adjacencyList = new Map();
        
        // Reconstruct adjacency lists and edge relation index
        this.edgeRelationIndex = new Map();
        for (const [nodeId, _node] of this.nodes) {
          this.adjacencyList.set(nodeId, new Set());
        }

        for (const [_edgeId, edge] of this.edges) {
          const neighbors = this.adjacencyList.get(edge.source);
          if (neighbors) {
            neighbors.add(edge.target);
          }
          if (!this.edgeRelationIndex.has(edge.source)) {
            this.edgeRelationIndex.set(edge.source, new Map());
          }
          this.edgeRelationIndex.get(edge.source).set(edge.target, edge.relation);
        }
      }
      this._loaded = true;
    } catch (e) {
      console.error('[Sentinel] Failed to load knowledge graph:', getErrorMessage(e));
      this._loaded = true;
    }
  }

  /**
   * Add a node to the knowledge graph
   * @param {string} id - Unique node identifier
   * @param {object} data - Node data { type, label, properties, source }
   * @returns {object} The created node
   */
  addNode(id, data = {}) {
    if (this.nodes.size >= MAX_NODES) {
      console.warn('[Sentinel] Knowledge graph at maximum node capacity');
      return null;
    }

    const node = {
      id,
      type: data.type || 'generic',
      label: data.label || id,
      properties: data.properties || {},
      source: data.source || 'unknown',
      createdAt: Date.now(),
      updatedAt: Date.now()
    };

    this.nodes.set(id, node);
    this.adjacencyList.set(id, new Set());
    
    return node;
  }

  /**
   * Update an existing node
   * @param {string} id - Node identifier
   * @param {object} updates - Properties to update
   * @returns {boolean} True if node was updated
   */
  updateNode(id, updates = {}) {
    const node = this.nodes.get(id);
    if (!node) return false;

    Object.assign(node.properties, updates.properties || {});
    if (updates.label) node.label = updates.label;
    if (updates.type) node.type = updates.type;
    node.updatedAt = Date.now();

    return true;
  }

  /**
   * Add an edge (relationship) between two nodes
   * @param {string} sourceId - Source node ID
   * @param {string} targetId - Target node ID
   * @param {object} data - Edge data { relation, weight, properties }
   * @returns {object|null} The created edge or null if failed
   */
  addEdge(sourceId, targetId, data = {}) {
    if (this.edges.size >= MAX_EDGES) {
      console.warn('[Sentinel] Knowledge graph at maximum edge capacity');
      return null;
    }

    if (!this.nodes.has(sourceId) || !this.nodes.has(targetId)) {
      console.warn('[Sentinel] Cannot add edge between non-existent nodes');
      return null;
    }

    const edgeId = `${sourceId}-${targetId}-${data.relation || 'related'}`;
    const edge = {
      id: edgeId,
      source: sourceId,
      target: targetId,
      relation: data.relation || 'related',
      weight: data.weight || 1.0,
      properties: data.properties || {},
      createdAt: Date.now()
    };

    this.edges.set(edgeId, edge);

    // Update adjacency list
    const sourceNeighbors = this.adjacencyList.get(sourceId);
    if (sourceNeighbors) {
      sourceNeighbors.add(targetId);
    }

    // Update edge relation index for O(1) lookups in getNeighbors
    if (!this.edgeRelationIndex.has(sourceId)) {
      this.edgeRelationIndex.set(sourceId, new Map());
    }
    this.edgeRelationIndex.get(sourceId).set(targetId, edge.relation);

    return edge;
  }

  /**
   * Get a node by ID
   * @param {string} id - Node identifier
   * @returns {object|null} Node object or null
   */
  getNode(id) {
    return this.nodes.get(id) || null;
  }

  /**
   * Get neighbors of a node
   * @param {string} nodeId - Node identifier
   * @param {number} maxDepth - Maximum depth to traverse (default: 1)
   * @returns {Map} Map of nodeId → edge relation
   */
  getNeighbors(nodeId, maxDepth = 1) {
    const result = new Map();
    const visited = new Set();
    const queue = [{ nodeId: nodeId, depth: 0 }];

    let queueIndex = 0;
    while (queueIndex < queue.length) {
      const { nodeId: currentId, depth } = queue[queueIndex++];

      if (depth >= maxDepth || visited.has(currentId)) {
        continue;
      }

      visited.add(currentId);
      const neighbors = this.adjacencyList.get(currentId);

      if (neighbors) {
        const sourceIndex = this.edgeRelationIndex.get(currentId);
        for (const neighborId of neighbors) {
          if (!visited.has(neighborId)) {
            const relation = sourceIndex?.get(neighborId) ?? 'related';
            result.set(neighborId, relation);
            queue.push({ nodeId: neighborId, depth: depth + 1 });
          }
        }
      }
    }

    return result;
  }

  /**
   * Find nodes by pattern matching
   * @param {object} pattern - Pattern to match { type, label, properties }
   * @returns {Array} Array of matching nodes
   */
  findNodes(pattern) {
    const matches = [];

    for (const node of this.nodes.values()) {
      let match = true;

      if (pattern.type && node.type !== pattern.type) {
        match = false;
      }

      if (pattern.label && !node.label.includes(pattern.label)) {
        match = false;
      }

      if (pattern.properties) {
        for (const [key, value] of Object.entries(pattern.properties)) {
          if (node.properties[key] !== value) {
            match = false;
            break;
          }
        }
      }

      if (match) {
        matches.push(node);
      }
    }

    return matches;
  }

  /**
   * Find potential contradictions in the knowledge graph
   * @returns {Array} Array of potential contradictions
   */
  findContradictions() {
    const contradictions = [];

    // Group nodes by type+label so we only compare within each group (O(n) grouping)
    const byTypeLabel = new Map();
    for (const node of this.nodes.values()) {
      const key = `${node.type}:${node.label.toLowerCase()}`;
      if (!byTypeLabel.has(key)) byTypeLabel.set(key, []);
      byTypeLabel.get(key).push(node);
    }

    for (const group of byTypeLabel.values()) {
      const len = group.length;
      if (len < 2) continue;

      for (let i = 0; i < len; i++) {
        for (let j = i + 1; j < len; j++) {
          const node = group[i];
          const otherNode = group[j];

          for (const [key, value] of Object.entries(node.properties)) {
            const otherValue = otherNode.properties[key];
            if (otherValue !== undefined && otherValue !== value) {
              contradictions.push({
                type: 'property_conflict',
                node1: node.id,
                node2: otherNode.id,
                property: key,
                value1: value,
                value2: otherValue,
                severity: 'medium'
              });
            }
          }
        }
      }
    }

    return contradictions;
  }

  /**
   * Detect novel information (nodes not connected to existing knowledge)
   * @param {string} nodeId - Node to check for novelty
   * @returns {boolean} True if node is novel (isolated)
   */
  isNovel(nodeId) {
    const neighbors = this.adjacencyList.get(nodeId);
    return !neighbors || neighbors.size === 0;
  }

  /**
   * Find the shortest path between two nodes
   * @param {string} sourceId - Source node ID
   * @param {string} targetId - Target node ID
   * @returns {Array|null} Array of node IDs in path or null if no path
   */
  findShortestPath(sourceId, targetId) {
    if (!this.nodes.has(sourceId) || !this.nodes.has(targetId)) {
      return null;
    }

    const visited = new Set();
    const queue = [[sourceId]];
    visited.add(sourceId);

    while (queue.length > 0) {
      const path = queue.shift();
      const currentNode = path[path.length - 1];

      if (currentNode === targetId) {
        return path;
      }

      const neighbors = this.adjacencyList.get(currentNode);
      if (neighbors) {
        for (const neighbor of neighbors) {
          if (!visited.has(neighbor)) {
            visited.add(neighbor);
            queue.push([...path, neighbor]);
          }
        }
      }
    }

    return null;
  }

  /**
   * Get statistics about the knowledge graph
   * @returns {object} Graph statistics
   */
  getStats() {
    const isolatedNodes = [];
    for (const [nodeId, neighbors] of this.adjacencyList) {
      if (neighbors.size === 0) {
        isolatedNodes.push(nodeId);
      }
    }

    return {
      nodeCount: this.nodes.size,
      edgeCount: this.edges.size,
      nodeTypes: this._countNodeTypes(),
      isolatedNodeCount: isolatedNodes.length,
      connectedComponentCount: this._countConnectedComponents(),
      avgDegree: this._calculateAverageDegree()
    };
  }

  _countNodeTypes() {
    const counts = {};
    for (const node of this.nodes.values()) {
      counts[node.type] = (counts[node.type] || 0) + 1;
    }
    return counts;
  }

  _countConnectedComponents() {
    const visited = new Set();
    let components = 0;

    for (const nodeId of this.nodes.keys()) {
      if (!visited.has(nodeId)) {
        components++;
        this._dfsVisit(nodeId, visited);
      }
    }

    return components;
  }

  _dfsVisit(nodeId, visited) {
    visited.add(nodeId);
    const neighbors = this.adjacencyList.get(nodeId);
    if (neighbors) {
      for (const neighborId of neighbors) {
        if (!visited.has(neighborId)) {
          this._dfsVisit(neighborId, visited);
        }
      }
    }
  }

  _calculateAverageDegree() {
    if (this.nodes.size === 0) return 0;
    let totalDegree = 0;
    for (const neighbors of this.adjacencyList.values()) {
      totalDegree += neighbors.size;
    }
    return totalDegree / this.nodes.size;
  }

  /**
   * Persist the knowledge graph to storage
   */
  async persist() {
    try {
      const data = {
        nodes: Object.fromEntries(this.nodes),
        edges: Object.fromEntries(this.edges)
      };
      await chrome.storage.local.set({ [STORAGE_KEY]: data });
    } catch (e) {
      console.error('[Sentinel] Failed to persist knowledge graph:', getErrorMessage(e));
    }
  }

  /**
   * Clear all data from the knowledge graph
   */
  async clear() {
    this.nodes.clear();
    this.edges.clear();
    this.adjacencyList.clear();
    this.edgeRelationIndex.clear();
    
    try {
      await chrome.storage.local.remove(STORAGE_KEY);
    } catch (e) {
      console.error('[Sentinel] Failed to clear knowledge graph:', getErrorMessage(e));
    }
  }
}

// Global instance
const knowledgeGraph = new KnowledgeGraph();

// Export functions
export async function initKnowledgeGraph() {
  await knowledgeGraph.init();
}

export function addKnowledgeNode(id, data) {
  return knowledgeGraph.addNode(id, data);
}

export function updateKnowledgeNode(id, updates) {
  return knowledgeGraph.updateNode(id, updates);
}

export function addKnowledgeEdge(sourceId, targetId, data) {
  return knowledgeGraph.addEdge(sourceId, targetId, data);
}

export function getKnowledgeNode(id) {
  return knowledgeGraph.getNode(id);
}

export function getKnowledgeNeighbors(nodeId, maxDepth = 1) {
  return knowledgeGraph.getNeighbors(nodeId, maxDepth);
}

export function findKnowledgeNodes(pattern) {
  return knowledgeGraph.findNodes(pattern);
}

export function findKnowledgeContradictions() {
  return knowledgeGraph.findContradictions();
}

export function isKnowledgeNovel(nodeId) {
  return knowledgeGraph.isNovel(nodeId);
}

export function findKnowledgePath(sourceId, targetId) {
  return knowledgeGraph.findShortestPath(sourceId, targetId);
}

export function getKnowledgeGraphStats() {
  return knowledgeGraph.getStats();
}

export async function persistKnowledgeGraph() {
  await knowledgeGraph.persist();
}

export async function clearKnowledgeGraph() {
  await knowledgeGraph.clear();
}

// Initialize on load — init() handles its own errors internally
initKnowledgeGraph().catch(() => {});