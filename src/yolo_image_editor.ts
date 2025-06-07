import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Custom Editor Provider for Image Annotation
export class YOLOImageEditorProvider implements vscode.CustomReadonlyEditorProvider {
    public static register(context: vscode.ExtensionContext): vscode.Disposable {
        const provider = new YOLOImageEditorProvider(context);
        const providerRegistration = vscode.window.registerCustomEditorProvider(
            'yolo-annotator.imageEditor',
            provider,
            {
                webviewOptions: {
                    retainContextWhenHidden: true,
                },
                supportsMultipleEditorsPerDocument: false,
            }
        );
        return providerRegistration;
    }

    constructor(private readonly context: vscode.ExtensionContext) {}

    public async openCustomDocument(
        uri: vscode.Uri,
        openContext: vscode.CustomDocumentOpenContext,
        token: vscode.CancellationToken
    ): Promise<YOLOImageDocument> {
        return new YOLOImageDocument(uri);
    }

    public async resolveCustomEditor(
        document: YOLOImageDocument,
        webviewPanel: vscode.WebviewPanel,
        token: vscode.CancellationToken
    ): Promise<void> {
        // Set up the webview with minimal overlay UI
        webviewPanel.webview.options = {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(path.dirname(document.uri.fsPath)),
                vscode.Uri.file(path.join(this.context.extensionPath, 'media'))
            ]
        };

        // Create the overlay UI
        webviewPanel.webview.html = this.getOverlayHTML(webviewPanel.webview, document.uri);
        
        // Set up message handling
        this.setupMessageHandling(webviewPanel, document);
    }

    private getOverlayHTML(webview: vscode.Webview, imageUri: vscode.Uri): string {
        const nonce = this.getNonce();
        const imageWebviewUri = webview.asWebviewUri(imageUri);
        
        return /*html*/`<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob: file:; script-src 'nonce-${nonce}';">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>YOLO Image Annotator</title>
    <style>
        body {
            margin: 0;
            padding: 0;
            height: 100vh;
            overflow: hidden;
            position: relative;
            background: #1e1e1e;
        }
        
        /* Native-like image container */
        .image-container {
            width: 100%;
            height: 100%;
            display: flex;
            justify-content: center;
            align-items: center;
            position: relative;
            background: #252526;
        }
        
        #mainImage {
            max-width: 100%;
            max-height: 100%;
            object-fit: contain;
            user-select: none;
            background: #333;
        }
        
        /* Overlay canvas for annotations */
        #annotationCanvas {
            position: absolute;
            top: 0;
            left: 0;
            pointer-events: none;
            z-index: 10;
        }
        
        /* Floating control panel */
        .control-panel {
            position: fixed;
            top: 20px;
            right: 20px;
            background: rgba(45, 45, 45, 0.95);
            border: 1px solid #3c3c3c;
            border-radius: 8px;
            padding: 15px;
            max-width: 300px;
            box-shadow: 0 4px 12px rgba(0, 0, 0, 0.3);
            backdrop-filter: blur(10px);
            z-index: 100;
            color: #cccccc;
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
            font-size: 13px;
        }
        
        .control-panel.collapsed {
            width: 40px;
            height: 40px;
            padding: 8px;
            overflow: hidden;
        }
        
        .panel-header {
            display: flex;
            justify-content: space-between;
            align-items: center;
            margin-bottom: 10px;
            border-bottom: 1px solid #444;
            padding-bottom: 5px;
        }
        
        .panel-title {
            font-weight: bold;
            color: #00aeff;
        }
        
        .collapse-btn {
            background: none;
            border: none;
            color: #cccccc;
            cursor: pointer;
            font-size: 16px;
            padding: 2px 5px;
        }
        
        .control-section {
            margin-bottom: 12px;
        }
        
        .control-section h4 {
            margin: 0 0 8px 0;
            font-size: 12px;
            color: #00aeff;
            text-transform: uppercase;
        }
        
        .button-group {
            display: flex;
            gap: 5px;
            flex-wrap: wrap;
        }
        
        button {
            background: #007acc;
            color: white;
            border: none;
            border-radius: 4px;
            padding: 6px 12px;
            cursor: pointer;
            font-size: 12px;
            transition: background-color 0.2s;
        }
        
        button:hover {
            background: #0095ff;
        }
        
        button:disabled {
            background: #555;
            color: #888;
            cursor: not-allowed;
        }
        
        button.active {
            background: #28a745;
        }
        
        button.danger {
            background: #dc3545;
        }
        
        /* Navigation controls */
        .nav-controls {
            display: flex;
            justify-content: space-between;
            align-items: center;
            gap: 10px;
        }
        
        .image-info {
            font-size: 11px;
            color: #bbbbbb;
            text-align: center;
            flex: 1;
        }
        
        /* Labels list in floating panel */
        .labels-list {
            max-height: 200px;
            overflow-y: auto;
            margin-top: 8px;
        }
        
        .label-item {
            background: #3f3f3f;
            border-radius: 4px;
            padding: 6px 8px;
            margin-bottom: 4px;
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            font-size: 11px;
            transition: background-color 0.2s;
        }
        
        .label-item:hover {
            background: #4a4a4a;
        }
        
        .label-item.selected {
            background: #005a99;
            border-left: 3px solid #00aeff;
        }
        
        .label-class {
            font-weight: bold;
        }
        
        .label-coords {
            color: #888;
            font-size: 10px;
        }
        
        /* Status indicator */
        .status-indicator {
            position: fixed;
            bottom: 20px;
            right: 20px;
            background: rgba(40, 167, 69, 0.9);
            color: white;
            padding: 8px 12px;
            border-radius: 4px;
            font-size: 12px;
            font-weight: bold;
            z-index: 101;
            opacity: 0;
            transition: opacity 0.3s;
        }
        
        .status-indicator.show {
            opacity: 1;
        }
        
        .status-indicator.error {
            background: rgba(220, 53, 69, 0.9);
        }
        
        /* Keyboard shortcuts help */
        .shortcuts-help {
            position: fixed;
            bottom: 20px;
            left: 20px;
            background: rgba(45, 45, 45, 0.95);
            border: 1px solid #3c3c3c;
            border-radius: 6px;
            padding: 10px;
            font-size: 11px;
            color: #888;
            z-index: 100;
            opacity: 0.7;
            transition: opacity 0.3s;
        }
        
        .shortcuts-help:hover {
            opacity: 1;
        }
        
        .shortcut-item {
            margin-bottom: 2px;
        }
        
        .shortcut-key {
            color: #00aeff;
            font-weight: bold;
        }
    </style>
</head>
<body>
    <div class="image-container">
        <img id="mainImage" src="${imageWebviewUri}" alt="Annotation Image">
        <canvas id="annotationCanvas"></canvas>
    </div>
    
    <!-- Floating Control Panel -->
    <div class="control-panel" id="controlPanel">
        <div class="panel-header">
            <span class="panel-title">YOLO Annotator</span>
            <button class="collapse-btn" id="collapseBtn">−</button>
        </div>
        
        <div class="panel-content" id="panelContent">
            <!-- Navigation -->
            <div class="control-section">
                <div class="nav-controls">
                    <button id="prevBtn" title="Previous Image (←)">‹</button>
                    <div class="image-info" id="imageInfo">1 / 1</div>
                    <button id="nextBtn" title="Next Image (→)">›</button>
                </div>
            </div>
            
            <!-- Annotation Tools -->
            <div class="control-section">
                <h4>Tools</h4>
                <div class="button-group">
                    <button id="addLabelBtn" title="Add Label (A)">Add Box</button>
                    <button id="saveBtn" class="active" title="Save (Ctrl+S)">Save</button>
                </div>
            </div>
            
            <!-- Current Labels -->
            <div class="control-section">
                <h4>Labels (<span id="labelCount">0</span>)</h4>
                <div class="labels-list" id="labelsList">
                    <div style="color: #888; font-style: italic; text-align: center;">No labels</div>
                </div>
            </div>
            
            <!-- Quick Actions -->
            <div class="control-section">
                <h4>Actions</h4>
                <div class="button-group">
                    <button id="clearAllBtn" class="danger" title="Clear All Labels">Clear All</button>
                    <button id="autoSuggestBtn" title="Auto-suggest based on similar images">AI Suggest</button>
                </div>
            </div>
        </div>
    </div>
    
    <!-- Status Indicator -->
    <div class="status-indicator" id="statusIndicator"></div>
    
    <!-- Keyboard Shortcuts Help -->
    <div class="shortcuts-help">
        <div class="shortcut-item"><span class="shortcut-key">A</span>: Add label</div>
        <div class="shortcut-item"><span class="shortcut-key">Ctrl+S</span>: Save</div>
        <div class="shortcut-item"><span class="shortcut-key">←/→</span>: Navigate</div>
        <div class="shortcut-item"><span class="shortcut-key">Del</span>: Delete selected</div>
        <div class="shortcut-item"><span class="shortcut-key">Esc</span>: Cancel drawing</div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        
        // Core elements
        const image = document.getElementById('mainImage');
        const canvas = document.getElementById('annotationCanvas');
        const ctx = canvas.getContext('2d');
        const controlPanel = document.getElementById('controlPanel');
        const panelContent = document.getElementById('panelContent');
        const collapseBtn = document.getElementById('collapseBtn');
        const statusIndicator = document.getElementById('statusIndicator');
        
        // Control elements
        const prevBtn = document.getElementById('prevBtn');
        const nextBtn = document.getElementById('nextBtn');
        const imageInfo = document.getElementById('imageInfo');
        const addLabelBtn = document.getElementById('addLabelBtn');
        const saveBtn = document.getElementById('saveBtn');
        const clearAllBtn = document.getElementById('clearAllBtn');
        const autoSuggestBtn = document.getElementById('autoSuggestBtn');
        const labelsList = document.getElementById('labelsList');
        const labelCount = document.getElementById('labelCount');
        
        // State
        let currentLabels = [];
        let selectedLabelIndex = -1;
        let isDrawing = false;
        let drawingMode = false;
        let startPos = null;
        let currentPos = null;
        let classNames = ['person', 'car', 'bicycle']; // Default classes
        
        // Panel collapse/expand
        collapseBtn.addEventListener('click', () => {
            controlPanel.classList.toggle('collapsed');
            collapseBtn.textContent = controlPanel.classList.contains('collapsed') ? '+' : '−';
        });
        
        // Image load handler
        image.addEventListener('load', () => {
            setupCanvas();
            loadImageLabels();
        });
        
        function setupCanvas() {
            const rect = image.getBoundingClientRect();
            canvas.width = image.naturalWidth;
            canvas.height = image.naturalHeight;
            canvas.style.width = rect.width + 'px';
            canvas.style.height = rect.height + 'px';
            canvas.style.position = 'absolute';
            canvas.style.top = rect.top + 'px';
            canvas.style.left = rect.left + 'px';
            canvas.style.pointerEvents = 'auto';
            
            redrawAnnotations();
        }
        
        function loadImageLabels() {
            // Request labels for current image
            vscode.postMessage({
                command: 'loadLabels',
                imagePath: '${imageUri.fsPath}'
            });
        }
        
        function redrawAnnotations() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            // Draw existing labels
            currentLabels.forEach((label, index) => {
                const isSelected = index === selectedLabelIndex;
                drawBoundingBox(label, isSelected, index);
            });
            
            // Draw current drawing
            if (isDrawing && drawingMode && startPos && currentPos) {
                drawCurrentBox();
            }
        }
        
        function drawBoundingBox(label, isSelected, index) {
            const x = (label.cx - label.w / 2) * canvas.width;
            const y = (label.cy - label.h / 2) * canvas.height;
            const width = label.w * canvas.width;
            const height = label.h * canvas.height;
            
            // Box
            ctx.strokeStyle = isSelected ? '#ff4444' : '#44ff44';
            ctx.lineWidth = isSelected ? 3 : 2;
            ctx.strokeRect(x, y, width, height);
            
            // Label background
            const className = classNames[label.classId] || \`Class \${label.classId}\`;
            const labelText = \`\${className} (\${index + 1})\`;
            
            ctx.font = '12px Arial';
            const textWidth = ctx.measureText(labelText).width;
            
            ctx.fillStyle = isSelected ? '#ff4444' : '#44ff44';
            ctx.fillRect(x, y - 20, textWidth + 8, 18);
            
            // Label text
            ctx.fillStyle = '#ffffff';
            ctx.fillText(labelText, x + 4, y - 6);
        }
        
        function drawCurrentBox() {
            const x = Math.min(startPos.x, currentPos.x);
            const y = Math.min(startPos.y, currentPos.y);
            const width = Math.abs(currentPos.x - startPos.x);
            const height = Math.abs(currentPos.y - startPos.y);
            
            ctx.strokeStyle = '#ffff44';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.strokeRect(x, y, width, height);
            ctx.setLineDash([]);
        }
        
        function updateLabelsList() {
            labelCount.textContent = currentLabels.length;
            
            if (currentLabels.length === 0) {
                labelsList.innerHTML = '<div style="color: #888; font-style: italic; text-align: center;">No labels</div>';
                return;
            }
            
            labelsList.innerHTML = '';
            currentLabels.forEach((label, index) => {
                const div = document.createElement('div');
                div.className = 'label-item' + (index === selectedLabelIndex ? ' selected' : '');
                
                const className = classNames[label.classId] || \`Class \${label.classId}\`;
                div.innerHTML = \`
                    <div>
                        <div class="label-class">\${className}</div>
                        <div class="label-coords">x:\${label.cx.toFixed(3)} y:\${label.cy.toFixed(3)}</div>
                    </div>
                    <button onclick="deleteLabel(\${index})" style="background: #dc3545; padding: 2px 6px; font-size: 10px;">×</button>
                \`;
                
                div.addEventListener('click', (e) => {
                    if (e.target.tagName !== 'BUTTON') {
                        selectLabel(index);
                    }
                });
                
                labelsList.appendChild(div);
            });
        }
        
        function selectLabel(index) {
            selectedLabelIndex = index;
            updateLabelsList();
            redrawAnnotations();
        }
        
        function deleteLabel(index) {
            currentLabels.splice(index, 1);
            if (selectedLabelIndex >= index) {
                selectedLabelIndex = selectedLabelIndex > 0 ? selectedLabelIndex - 1 : -1;
            }
            updateLabelsList();
            redrawAnnotations();
            showStatus('Label deleted', false);
        }
        
        function showStatus(message, isError = false) {
            statusIndicator.textContent = message;
            statusIndicator.className = 'status-indicator show' + (isError ? ' error' : '');
            setTimeout(() => {
                statusIndicator.classList.remove('show');
            }, 3000);
        }
        
        // Event Listeners
        addLabelBtn.addEventListener('click', () => {
            drawingMode = !drawingMode;
            addLabelBtn.textContent = drawingMode ? 'Cancel' : 'Add Box';
            addLabelBtn.className = drawingMode ? 'danger' : '';
            canvas.style.cursor = drawingMode ? 'crosshair' : 'default';
        });
        
        saveBtn.addEventListener('click', () => {
            vscode.postMessage({
                command: 'saveLabels',
                imagePath: '${imageUri.fsPath}',
                labels: currentLabels
            });
        });
        
        clearAllBtn.addEventListener('click', () => {
            if (confirm('Clear all labels for this image?')) {
                currentLabels = [];
                selectedLabelIndex = -1;
                updateLabelsList();
                redrawAnnotations();
                showStatus('All labels cleared', false);
            }
        });
        
        // Canvas interaction
        canvas.addEventListener('mousedown', (e) => {
            if (drawingMode) {
                const rect = canvas.getBoundingClientRect();
                startPos = {
                    x: (e.clientX - rect.left) * (canvas.width / rect.width),
                    y: (e.clientY - rect.top) * (canvas.height / rect.height)
                };
                isDrawing = true;
            } else {
                // Select existing label
                const rect = canvas.getBoundingClientRect();
                const x = (e.clientX - rect.left) * (canvas.width / rect.width);
                const y = (e.clientY - rect.top) * (canvas.height / rect.height);
                
                const clickedIndex = findLabelAtPosition(x, y);
                if (clickedIndex !== -1) {
                    selectLabel(clickedIndex);
                }
            }
        });
        
        canvas.addEventListener('mousemove', (e) => {
            if (isDrawing && drawingMode) {
                const rect = canvas.getBoundingClientRect();
                currentPos = {
                    x: (e.clientX - rect.left) * (canvas.width / rect.width),
                    y: (e.clientY - rect.top) * (canvas.height / rect.height)
                };
                redrawAnnotations();
            }
        });
        
        canvas.addEventListener('mouseup', (e) => {
            if (isDrawing && drawingMode && startPos && currentPos) {
                const x = Math.min(startPos.x, currentPos.x);
                const y = Math.min(startPos.y, currentPos.y);
                const width = Math.abs(currentPos.x - startPos.x);
                const height = Math.abs(currentPos.y - startPos.y);
                
                if (width > 10 && height > 10) {
                    const label = {
                        classId: 0,
                        cx: (x + width / 2) / canvas.width,
                        cy: (y + height / 2) / canvas.height,
                        w: width / canvas.width,
                        h: height / canvas.height
                    };
                    
                    currentLabels.push(label);
                    selectedLabelIndex = currentLabels.length - 1;
                    updateLabelsList();
                    showStatus('Label added', false);
                }
                
                isDrawing = false;
                drawingMode = false;
                addLabelBtn.textContent = 'Add Box';
                addLabelBtn.className = '';
                canvas.style.cursor = 'default';
                redrawAnnotations();
            }
        });
        
        function findLabelAtPosition(x, y) {
            for (let i = currentLabels.length - 1; i >= 0; i--) {
                const label = currentLabels[i];
                const lx = (label.cx - label.w / 2) * canvas.width;
                const ly = (label.cy - label.h / 2) * canvas.height;
                const lw = label.w * canvas.width;
                const lh = label.h * canvas.height;
                
                if (x >= lx && x <= lx + lw && y >= ly && y <= ly + lh) {
                    return i;
                }
            }
            return -1;
        }
        
        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            switch (e.key) {
                case 'a':
                case 'A':
                    if (!e.ctrlKey) {
                        e.preventDefault();
                        addLabelBtn.click();
                    }
                    break;
                case 's':
                    if (e.ctrlKey) {
                        e.preventDefault();
                        saveBtn.click();
                    }
                    break;
                case 'ArrowLeft':
                    e.preventDefault();
                    prevBtn.click();
                    break;
                case 'ArrowRight':
                    e.preventDefault();
                    nextBtn.click();
                    break;
                case 'Delete':
                    if (selectedLabelIndex !== -1) {
                        e.preventDefault();
                        deleteLabel(selectedLabelIndex);
                    }
                    break;
                case 'Escape':
                    if (drawingMode) {
                        e.preventDefault();
                        addLabelBtn.click();
                    }
                    break;
            }
        });
        
        // Handle window resize
        window.addEventListener('resize', () => {
            setTimeout(setupCanvas, 100);
        });
        
        // Handle messages from extension
        window.addEventListener('message', (e) => {
            const message = e.data;
            switch (message.command) {
                case 'labelsLoaded':
                    currentLabels = message.labels || [];
                    updateLabelsList();
                    redrawAnnotations();
                    break;
                case 'labelsSaved':
                    showStatus('Labels saved successfully', false);
                    break;
                case 'error':
                    showStatus(message.message, true);
                    break;
            }
        });
        
        // Initialize
        if (image.complete) {
            setupCanvas();
            loadImageLabels();
        }
    </script>
</body>
</html>`;
    }

    private async setupMessageHandling(webviewPanel: vscode.WebviewPanel, document: YOLOImageDocument): Promise<void> {
        // Batch operations for better remote performance
        const pendingSaves = new Map<string, any[]>();
        let saveTimeout: NodeJS.Timeout;

        const flushPendingSaves = async () => {
            if (pendingSaves.size === 0) {return;}
            
            const savePromises = Array.from(pendingSaves.entries()).map(
                ([imagePath, labels]) => this.saveLabelsForImage(imagePath, labels)
            );
            
            try {
                await Promise.all(savePromises);
                webviewPanel.webview.postMessage({ 
                    command: 'batchSaveComplete',
                    count: pendingSaves.size 
                });
            } catch (error) {
                webviewPanel.webview.postMessage({ 
                    command: 'error', 
                    message: 'Batch save failed' 
                });
            }
            
            pendingSaves.clear();
        };

        webviewPanel.webview.onDidReceiveMessage(async (message) => {
            switch (message.command) {
                case 'loadLabels':
                    const labels = await this.loadLabelsForImage(message.imagePath);
                    webviewPanel.webview.postMessage({
                        command: 'labelsLoaded',
                        labels: labels
                    });
                    break;
                    
                case 'saveLabels':
                    // Batch saves for remote efficiency
                    pendingSaves.set(message.imagePath, message.labels);
                    
                    if (saveTimeout) {clearTimeout(saveTimeout);}
                    saveTimeout = setTimeout(flushPendingSaves, 2000); // Batch for 2 seconds
                    break;
                    
                case 'forceSave':
                    // Immediate save for critical operations
                    if (saveTimeout) {
                        clearTimeout(saveTimeout);
                        await flushPendingSaves();
                    }
                    break;
                    
                case 'preloadNextImage':
                    // Preload next image for smoother navigation
                    this.preloadImageLabels(message.nextImagePath);
                    break;
            }
        });
    }

    private async loadLabelsForImage(imagePath: string): Promise<any[]> {
        try {
            const labelPath = this.getLabelsPath(imagePath);
            
            // Cache check for remote performance
            const cacheKey = `labels_${path.basename(labelPath)}`;
            const cached = this.labelCache.get(cacheKey);
            if (cached && cached.mtime === await this.getFileModTime(labelPath)) {
                return cached.labels;
            }
            
            const labelContent = await fs.promises.readFile(labelPath, 'utf-8');
            const labels = labelContent
                .split('\n')
                .filter(line => line.trim())
                .map(line => {
                    const parts = line.split(' ');
                    return {
                        classId: parseInt(parts[0]),
                        cx: parseFloat(parts[1]),
                        cy: parseFloat(parts[2]),
                        w: parseFloat(parts[3]),
                        h: parseFloat(parts[4])
                    };
                });
            
            // Cache the result
            const mtime = await this.getFileModTime(labelPath);
            this.labelCache.set(cacheKey, { labels, mtime });
            
            return labels;
        } catch (error) {
            return [];
        }
    }

    private labelCache = new Map<string, { labels: any[], mtime: number }>();

    private async getFileModTime(filePath: string): Promise<number> {
        try {
            const stats = await fs.promises.stat(filePath);
            return stats.mtime.getTime();
        } catch {
            return 0;
        }
    }

    private async saveLabelsForImage(imagePath: string, labels: any[]): Promise<boolean> {
        try {
            const labelPath = this.getLabelsPath(imagePath);
            const content = labels
                .map(l => `${l.classId} ${l.cx.toFixed(6)} ${l.cy.toFixed(6)} ${l.w.toFixed(6)} ${l.h.toFixed(6)}`)
                .join('\n');
                
            await fs.promises.mkdir(path.dirname(labelPath), { recursive: true });
            await fs.promises.writeFile(labelPath, content);
            return true;
        } catch (error) {
            return false;
        }
    }

    private getLabelsPath(imagePath: string): string {
        const dir = path.dirname(imagePath);
        const name = path.basename(imagePath, path.extname(imagePath));
        
        // Use the predictAsumedLabelsDirPath logic here
        const labelsDir = dir.replace(/images/gi, 'labels');
        return path.join(labelsDir, `${name}.txt`);
    }

    private async preloadImageLabels(imagePath: string): Promise<void> {
        // Preload labels for performance optimization
        try {
            await this.loadLabelsForImage(imagePath);
            console.log(`Preloaded labels for: ${path.basename(imagePath)}`);
        } catch (error) {
            console.warn(`Failed to preload labels for: ${imagePath}`, error);
        }
    }

    private getNonce(): string {
        let text = '';
        const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
        for (let i = 0; i < 32; i++) {
            text += possible.charAt(Math.floor(Math.random() * possible.length));
        }
        return text;
    }
}

class YOLOImageDocument implements vscode.CustomDocument {
    constructor(public readonly uri: vscode.Uri) {}

    dispose(): void {
        // Cleanup if needed
    }
}
