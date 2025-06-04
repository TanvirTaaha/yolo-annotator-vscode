import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

// Type definitions for better type safety
interface YOLOLabel {
    classId: number;
    cx: number;
    cy: number;
    w: number;
    h: number;
}

interface ExtensionState {
    allImagesInDir: string[];
    currentImageIndex: number;
    imagesDirPath: string | undefined;
    labelsDirPath: string | undefined;
    classNames: string[];
    webviewPanel: vscode.WebviewPanel | undefined;
}

interface DroppedFile {
    name: string;
    path: string;
    type: 'image' | 'label' | 'classes';
    content?: string;
}

// Store extension state globally within the activate function's scope
let state: ExtensionState = {
    allImagesInDir: [],
    currentImageIndex: -1,
    imagesDirPath: undefined,
    labelsDirPath: undefined,
    classNames: [],
    webviewPanel: undefined
};

export function activate(context: vscode.ExtensionContext) {
    console.log('YOLO Annotator extension is now active.');

    const disposable = vscode.commands.registerCommand('yolo-annotator.start', async () => {
        try {
            // Create webview panel immediately without requiring directory selection
            await createInitialWebviewPanel(context);
        } catch (error) {
            console.error('Error starting YOLO Annotator:', error);
            vscode.window.showErrorMessage(`Failed to start YOLO Annotator: ${error instanceof Error ? error.message : 'Unknown error'}`);
        }
    });

    context.subscriptions.push(disposable);
}

async function createInitialWebviewPanel(context: vscode.ExtensionContext): Promise<void> {
    // Reset state for a new session
    resetState();

    // Create webview panel without requiring initial setup
    state.webviewPanel = vscode.window.createWebviewPanel(
        'yoloAnnotator',
        'YOLO Annotation Editor',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(path.join(context.extensionPath, 'media'))
            ],
            retainContextWhenHidden: true
        }
    );

    // Handle webview messages
    state.webviewPanel.webview.onDidReceiveMessage(
        async message => {
            try {
                await handleWebviewMessage(message, context);
            } catch (error) {
                console.error('Error handling webview message:', error);
                vscode.window.showErrorMessage(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        },
        undefined,
        context.subscriptions
    );

    // Generate webview HTML
    state.webviewPanel.webview.html = getWebviewContent(state.webviewPanel.webview);

    // Handle panel disposal
    state.webviewPanel.onDidDispose(() => {
        resetState();
        console.log('YOLO Annotator panel disposed and state reset.');
    }, null, context.subscriptions);
}

async function initializeAnnotationSession(context: vscode.ExtensionContext): Promise<void> {
    // Reset state for a new session
    resetState();

    // Configuration inputs with better validation
    const imageDirUri = await getDirectory('Select Images Directory (JPEG, PNG, JPG)');
    if (!imageDirUri) {
        throw new Error('Image directory selection is required.');
    }
    state.imagesDirPath = imageDirUri.fsPath;

    const labelDirUri = await getDirectory('Select Labels Directory (for .txt files)');
    if (!labelDirUri) {
        throw new Error('Label directory selection is required.');
    }
    state.labelsDirPath = labelDirUri.fsPath;

    const classesFileUri = await getFile('Select classes.txt file', 'txt');
    if (!classesFileUri) {
        throw new Error('classes.txt file selection is required.');
    }

    // Read and validate class names
    await loadClassNames(classesFileUri.fsPath);

    // Read and validate images from directory
    await loadImages();

    // Create and configure webview panel
    await createWebviewPanel(context);
}

function resetState(): void {
    state.allImagesInDir = [];
    state.currentImageIndex = -1;
    state.imagesDirPath = undefined;
    state.labelsDirPath = undefined;
    state.classNames = [];
    
    if (state.webviewPanel) {
        state.webviewPanel.dispose();
        state.webviewPanel = undefined;
    }
}

async function loadClassNames(classesFilePath: string): Promise<void> {
    try {
        const content = await fs.promises.readFile(classesFilePath, 'utf-8');
        state.classNames = content
            .split('\n')
            .map(c => c.trim())
            .filter(c => c.length > 0);

        if (state.classNames.length === 0) {
            vscode.window.showWarningMessage('classes.txt is empty or contains no valid class names. Annotations may not have proper class labels.');
        }
    } catch (error) {
        throw new Error(`Error reading classes.txt: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

async function loadImages(): Promise<void> {
    if (!state.imagesDirPath) {
        throw new Error('Images directory path is not set');
    }

    try {
        const files = await fs.promises.readdir(state.imagesDirPath);
        state.allImagesInDir = files
            .filter(f => ['.jpg', '.png', '.jpeg', '.JPG', '.JPEG', '.PNG'].includes(path.extname(f)))
            .sort(); // Sort for consistent order

        if (state.allImagesInDir.length === 0) {
            throw new Error('No images found in the selected directory.');
        }
    } catch (error) {
        throw new Error(`Error reading images directory: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

async function createWebviewPanel(context: vscode.ExtensionContext): Promise<void> {
    if (!state.imagesDirPath) {
        throw new Error('Images directory path is not set');
    }

    if (state.webviewPanel) {
        // Update existing panel's local resource roots
        state.webviewPanel.dispose();
    }

    state.webviewPanel = vscode.window.createWebviewPanel(
        'yoloAnnotator',
        'YOLO Annotation Editor',
        vscode.ViewColumn.One,
        {
            enableScripts: true,
            localResourceRoots: [
                vscode.Uri.file(state.imagesDirPath),
                vscode.Uri.file(path.join(context.extensionPath, 'media'))
            ],
            retainContextWhenHidden: true
        }
    );

    // Handle webview messages
    state.webviewPanel.webview.onDidReceiveMessage(
        async message => {
            try {
                await handleWebviewMessage(message, context);
            } catch (error) {
                console.error('Error handling webview message:', error);
                vscode.window.showErrorMessage(`Error: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
        },
        undefined,
        context.subscriptions
    );

    // Generate webview HTML
    state.webviewPanel.webview.html = getWebviewContent(state.webviewPanel.webview);

    // Handle panel disposal
    state.webviewPanel.onDidDispose(() => {
        resetState();
        console.log('YOLO Annotator panel disposed and state reset.');
    }, null, context.subscriptions);
}

async function handleWebviewMessage(message: any, context?: vscode.ExtensionContext): Promise<void> {
    switch (message.command) {
        case 'saveLabels':
            if (state.labelsDirPath && message.imageName && message.labels) {
                const saved = await saveLabels(state.labelsDirPath, message.imageName, message.labels);
                if (saved) {
                    vscode.window.showInformationMessage(`Labels saved for ${message.imageName}`);
                    state.webviewPanel?.webview.postMessage({ 
                        command: 'labelsSaved', 
                        imageName: message.imageName 
                    });
                }
            }
            break;

        case 'requestNextImage':
            if (state.currentImageIndex < state.allImagesInDir.length - 1) {
                state.currentImageIndex++;
                await sendImageDataToWebview(state.currentImageIndex);
            } else {
                state.webviewPanel?.webview.postMessage({ 
                    command: 'updateNavButtons', 
                    canGoNext: false, 
                    canGoPrev: state.currentImageIndex > 0 
                });
            }
            break;

        case 'requestPreviousImage':
            if (state.currentImageIndex > 0) {
                state.currentImageIndex--;
                await sendImageDataToWebview(state.currentImageIndex);
            } else {
                state.webviewPanel?.webview.postMessage({ 
                    command: 'updateNavButtons', 
                    canGoNext: state.allImagesInDir.length > 1, 
                    canGoPrev: false 
                });
            }
            break;

        case 'webviewReady':
            if (state.allImagesInDir.length > 0 && state.currentImageIndex === -1) {
                state.currentImageIndex = 0;
                await sendImageDataToWebview(state.currentImageIndex);
            } else if (state.allImagesInDir.length === 0) {
                state.webviewPanel?.webview.postMessage({ command: 'noImagesFound' });
            }
            break;

        case 'showError':
            if (message.message) {
                vscode.window.showErrorMessage(message.message);
            }
            break;

        case 'filesDropped':
            await handleDroppedFiles(message.files);
            break;
            
        case 'loadDroppedImage':
            if (message.imagePath && message.labelPath) {
                await loadSpecificImage(message.imagePath, message.labelPath);
            }
            break;

        case 'requestDirectorySelection':
            try {
                await initializeAnnotationSession(context!);
            } catch (error) {
                console.error('Error initializing annotation session:', error);
                vscode.window.showErrorMessage(`Failed to initialize session: ${error instanceof Error ? error.message : 'Unknown error'}`);
            }
            break;
    }
}

async function handleDroppedFiles(files: DroppedFile[]): Promise<void> {
    try {
        const imageFiles = files.filter(f => f.type === 'image');
        const labelFiles = files.filter(f => f.type === 'label');
        const classFiles = files.filter(f => f.type === 'classes');

        if (imageFiles.length === 0) {
            vscode.window.showErrorMessage('No valid image files found in dropped files.');
            return;
        }

        // Load classes if provided
        if (classFiles.length > 0) {
            await loadClassNames(classFiles[0].path);
        } else if (state.classNames.length === 0) {
            // Prompt for classes file if none loaded
            const classesFileUri = await getFile('Select classes.txt file', 'txt');
            if (classesFileUri) {
                await loadClassNames(classesFileUri.fsPath);
            } else {
                vscode.window.showWarningMessage('No classes file selected. Using default class names.');
                state.classNames = ['object']; // Default class
            }
        }

        // Set up directories based on dropped files
        const firstImagePath = imageFiles[0].path;
        state.imagesDirPath = path.dirname(firstImagePath);
        
        if (labelFiles.length > 0) {
            state.labelsDirPath = path.dirname(labelFiles[0].path);
        } else {
            // Default to same directory as images
            state.labelsDirPath = state.imagesDirPath;
        }

        // Update image list
        await loadImages();

        // Find and load the dropped image
        const droppedImageName = path.basename(firstImagePath);
        const imageIndex = state.allImagesInDir.findIndex(name => name === droppedImageName);
        
        if (imageIndex !== -1) {
            state.currentImageIndex = imageIndex;
            await sendImageDataToWebview(imageIndex);
            vscode.window.showInformationMessage(`Loaded ${imageFiles.length} image(s) and ${labelFiles.length} label file(s).`);
        } else {
            vscode.window.showErrorMessage('Dropped image not found in directory.');
        }

    } catch (error) {
        console.error('Error handling dropped files:', error);
        vscode.window.showErrorMessage(`Error processing dropped files: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

async function loadSpecificImage(imagePath: string, labelPath?: string): Promise<void> {
    try {
        // Set paths if not already set
        if (!state.imagesDirPath) {
            state.imagesDirPath = path.dirname(imagePath);
            await loadImages();
        }
        
        if (!state.labelsDirPath && labelPath) {
            state.labelsDirPath = path.dirname(labelPath);
        }

        const imageName = path.basename(imagePath);
        const imageIndex = state.allImagesInDir.findIndex(name => name === imageName);
        
        if (imageIndex !== -1) {
            state.currentImageIndex = imageIndex;
            await sendImageDataToWebview(imageIndex);
        } else {
            vscode.window.showErrorMessage(`Image ${imageName} not found in current directory.`);
        }
    } catch (error) {
        console.error('Error loading specific image:', error);
        vscode.window.showErrorMessage(`Error loading image: ${error instanceof Error ? error.message : 'Unknown error'}`);
    }
}

async function getDirectory(title: string): Promise<vscode.Uri | undefined> {
    const result = await vscode.window.showOpenDialog({
        canSelectFolders: true,
        canSelectFiles: false,
        title
    });
    return result ? result[0] : undefined;
}

async function getFile(title: string, ...ext: string[]): Promise<vscode.Uri | undefined> {
    const result = await vscode.window.showOpenDialog({
        canSelectFolders: false,
        canSelectMany: false,
        title,
        filters: { 'Files': ext }
    });
    return result ? result[0] : undefined;
}

async function saveLabels(labelDir: string, imageName: string, labels: YOLOLabel[]): Promise<boolean> {
    const baseName = path.basename(imageName, path.extname(imageName));
    const labelPath = path.join(labelDir, `${baseName}.txt`);
    const content = labels
        .map(l => `${l.classId} ${l.cx.toFixed(6)} ${l.cy.toFixed(6)} ${l.w.toFixed(6)} ${l.h.toFixed(6)}`)
        .join('\n');

    try {
        // Ensure target directory exists
        await fs.promises.mkdir(labelDir, { recursive: true });

        // Check if file exists and prompt for overwrite if it's not empty
        try {
            const existingContent = await fs.promises.readFile(labelPath, 'utf-8');
            if (existingContent.trim() !== '') {
                const choice = await vscode.window.showWarningMessage(
                    `Label file for "${imageName}" already exists. Overwrite?`,
                    { modal: true },
                    "Overwrite"
                );

                if (choice !== "Overwrite") {
                    vscode.window.showInformationMessage('Save operation cancelled.');
                    return false;
                }
            }
        } catch (error) {
            // File doesn't exist, which is fine
        }

        await fs.promises.writeFile(labelPath, content);
        return true;
    } catch (error) {
        const errorMessage = error instanceof Error ? error.message : 'Unknown error';
        vscode.window.showErrorMessage(`Failed to save labels for ${imageName}: ${errorMessage}`);
        console.error(`Failed to save labels to ${labelPath}:`, error);
        return false;
    }
}

async function sendImageDataToWebview(imageIndex: number): Promise<void> {
    if (!state.imagesDirPath || !state.webviewPanel || imageIndex < 0 || imageIndex >= state.allImagesInDir.length) {
        console.error('Invalid state for sending image data:', { 
            imagesDirPath: state.imagesDirPath, 
            imageIndex, 
            allImagesInDirLength: state.allImagesInDir.length 
        });
        state.webviewPanel?.webview.postMessage({ 
            command: 'error', 
            message: 'Could not load image data (invalid index or path).' 
        });
        return;
    }

    const imageName = state.allImagesInDir[imageIndex];
    const imageFileOnDisk = vscode.Uri.file(path.join(state.imagesDirPath, imageName));
    
    // Check if the image file actually exists
    try {
        await fs.promises.access(imageFileOnDisk.fsPath);
    } catch (error) {
        console.error(`Image file not found: ${imageFileOnDisk.fsPath}`);
        state.webviewPanel.webview.postMessage({ 
            command: 'error', 
            message: `Image file "${imageName}" not found.` 
        });
        vscode.window.showErrorMessage(`Image file ${imageName} is missing. Please check the image directory.`);
        return;
    }

    // Convert image to base64 for remote compatibility
    try {
        const imageBuffer = await fs.promises.readFile(imageFileOnDisk.fsPath);
        const base64Image = imageBuffer.toString('base64');
        const mimeType = getMimeType(imageName);
        const dataUri = `data:${mimeType};base64,${base64Image}`;
        
        const parsedLabels = await loadLabelsForImage(imageName);

        state.webviewPanel.webview.postMessage({
            command: 'loadImage',
            imageName: imageName,
            imageUri: dataUri, // Use base64 instead of webview URI
            labels: parsedLabels,
            classes: state.classNames,
            currentIndex: imageIndex,
            totalImages: state.allImagesInDir.length
        });
    } catch (error) {
        console.error(`Error reading image file: ${imageFileOnDisk.fsPath}`, error);
        state.webviewPanel.webview.postMessage({ 
            command: 'error', 
            message: `Failed to read image file: ${imageName}` 
        });
    }
}

function getMimeType(filename: string): string {
    const ext = path.extname(filename).toLowerCase();
    switch (ext) {
        case '.jpg':
        case '.jpeg':
            return 'image/jpeg';
        case '.png':
            return 'image/png';
        case '.gif':
            return 'image/gif';
        case '.webp':
            return 'image/webp';
        default:
            return 'image/jpeg';
    }
}

async function loadLabelsForImage(imageName: string): Promise<YOLOLabel[]> {
    if (!state.labelsDirPath) {
        return [];
    }

    const baseName = path.basename(imageName, path.extname(imageName));
    const labelPath = path.join(state.labelsDirPath, `${baseName}.txt`);
    
    try {
        const labelContent = await fs.promises.readFile(labelPath, 'utf-8');
        return labelContent
            .split('\n')
            .filter(l => l.trim())
            .map(line => {
                const parts = line.split(' ');
                if (parts.length < 5) {
                    console.warn(`Skipping malformed label line (not enough parts) in ${labelPath}: ${line}`);
                    return null;
                }

                const classId = parseInt(parts[0], 10);
                const cx = parseFloat(parts[1]);
                const cy = parseFloat(parts[2]);
                const w = parseFloat(parts[3]);
                const h = parseFloat(parts[4]);

                if (isNaN(classId) || isNaN(cx) || isNaN(cy) || isNaN(w) || isNaN(h)) {
                    console.warn(`Skipping malformed label line (NaN values) in ${labelPath}: ${line}`);
                    return null;
                }

                // Basic validation for YOLO coordinates (0 to 1)
                if (cx < 0 || cx > 1 || cy < 0 || cy > 1 || w < 0 || w > 1 || h < 0 || h > 1) {
                    console.warn(`Skipping label with out-of-bounds coordinates in ${labelPath}: ${line}`);
                    return null;
                }

                if (w === 0 || h === 0) {
                    console.warn(`Skipping label with zero width/height in ${labelPath}: ${line}`);
                    return null;
                }

                return { classId, cx, cy, w, h };
            })
            .filter((label): label is YOLOLabel => label !== null);
    } catch (error) {
        // File doesn't exist or can't be read - this is normal for new images
        return [];
    }
}

function getWebviewContent(webview: vscode.Webview): string {
    const nonce = getNonce();
    
    return `<!DOCTYPE html>
<html lang="en">
<head>
    <meta charset="UTF-8">
    <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; img-src ${webview.cspSource} data: blob:; script-src 'nonce-${nonce}'; font-src ${webview.cspSource};">
    <meta name="viewport" content="width=device-width, initial-scale=1.0">
    <title>YOLO Annotation Editor</title>
    <style>
        body { 
            font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif; 
            margin: 0; 
            padding: 0; 
            display: flex; 
            height: 100vh; 
            overflow: hidden; 
            font-size: 14px; 
            background-color: #1e1e1e; 
            color: #cccccc;
        }
        
        .container { 
            display: flex; 
            width: 100%; 
            height: 100%; 
            position: relative;
        }
        
        .drop-zone {
            position: absolute;
            top: 0;
            left: 0;
            right: 0;
            bottom: 0;
            background-color: rgba(0, 123, 255, 0.1);
            border: 3px dashed #007acc;
            display: none;
            justify-content: center;
            align-items: center;
            z-index: 1000;
            pointer-events: none;
        }
        
        .drop-zone.active {
            display: flex;
        }
        
        .drop-message {
            background-color: rgba(0, 123, 255, 0.9);
            color: white;
            padding: 20px 40px;
            border-radius: 10px;
            font-size: 18px;
            font-weight: bold;
            text-align: center;
        }
        
        .file-input-area {
            margin-bottom: 15px;
            padding: 20px;
            border: 2px dashed #555;
            border-radius: 8px;
            text-align: center;
            background-color: #3c3c3c;
            transition: all 0.3s ease;
        }
        
        .file-input-area:hover {
            border-color: #007acc;
            background-color: #404040;
        }
        
        .file-input-area p {
            margin: 0;
            color: #bbb;
            font-size: 14px;
        }
        
        .image-panel { 
            flex: 3; 
            position: relative; 
            overflow: auto; 
            background-color: #252526; 
            display: flex; 
            justify-content: center; 
            align-items: center; 
            padding: 10px;
        }
        
        .image-container { 
            position: relative; 
            box-shadow: 0 0 10px rgba(0,0,0,0.5); 
        } 
        
        #mainImage { 
            display: block; 
            max-width: 100%; 
            max-height: calc(100vh - 40px); 
            user-select: none; 
            background-color: #333; 
        } 
        
        #canvas { 
            position: absolute; 
            top: 0; 
            left: 0; 
            cursor: crosshair; 
            user-select: none; 
        }
        
        .controls-panel { 
            flex: 1; 
            padding: 15px; 
            overflow-y: auto; 
            background-color: #2d2d2d; 
            border-left: 1px solid #3c3c3c; 
            display: flex; 
            flex-direction: column; 
            min-width: 280px; 
            max-width: 400px;
        }
        
        .control-group { 
            margin-bottom: 15px; 
            padding: 12px; 
            background-color: #333333; 
            border-radius: 6px; 
            box-shadow: 0 1px 3px rgba(0,0,0,0.2); 
        }
        
        .control-group h3 { 
            margin-top: 0; 
            margin-bottom: 12px; 
            font-size: 16px; 
            color: #00aeff; 
            border-bottom: 1px solid #444; 
            padding-bottom: 5px;
        }
        
        .navigation-controls { 
            display: flex; 
            justify-content: space-between; 
            align-items: center; 
            margin-bottom: 12px; 
        }
        
        #imageInfo { 
            font-weight: bold; 
            color: #bbbbbb; 
        }
        
        button { 
            padding: 8px 15px; 
            background-color: #007acc; 
            color: white; 
            border: none; 
            border-radius: 4px; 
            cursor: pointer; 
            font-size: 14px;
            transition: background-color 0.2s ease;
            margin: 2px;
        }
        
        button:hover { 
            background-color: #0095ff; 
        }
        
        button:disabled { 
            background-color: #555; 
            color: #888; 
            cursor: not-allowed; 
        }
        
        #editFormContainer { 
            margin-top: 10px; 
        }
        
        #editFormContainer label { 
            display: block; 
            margin-bottom: 6px; 
            font-weight: bold; 
            color: #cccccc; 
        }
        
        #editFormContainer select, 
        #editFormContainer input[type="number"] { 
            width: calc(100% - 12px); 
            padding: 8px; 
            margin-bottom: 12px; 
            border-radius: 4px; 
            border: 1px solid #555; 
            background-color: #3c3c3c;
            color: #ddd;
        }
        
        #editFormContainer select:focus, 
        #editFormContainer input[type="number"]:focus {
            border-color: #007acc;
            outline: none;
        }
        
        #labelListDisplay .label-item { 
            padding: 10px; 
            margin-bottom: 6px; 
            background-color: #3f3f3f; 
            border-radius: 4px; 
            cursor: pointer;
            display: flex;
            justify-content: space-between;
            align-items: center;
            transition: background-color 0.2s ease;
            border-left: 3px solid transparent;
        }
        
        #labelListDisplay .label-item:hover { 
            background-color: #4a4a4a; 
        }
        
        #labelListDisplay .label-item.selected { 
            background-color: #005a99; 
            font-weight: bold; 
            color: white;
            border-left: 3px solid #00aeff;
        }

        .no-content { 
            text-align: center; 
            color: #888; 
            margin-top: 20px; 
            font-style: italic; 
        }
        
        .status-message {
            padding: 10px;
            margin-bottom: 10px;
            border-radius: 4px;
            text-align: center;
            font-weight: bold;
        }
        
        .status-success { 
            background-color: #28a745; 
            color: white; 
        }
        
        .status-error { 
            background-color: #dc3545; 
            color: white; 
        }
        
        .status-info { 
            background-color: #17a2b8; 
            color: white; 
        }
    </style>
</head>
<body>
    <div class="container">
        <div class="drop-zone" id="dropZone">
            <div class="drop-message">
                Drop images (.jpg, .png), labels (.txt), or classes.txt files here
            </div>
        </div>
        
        <div class="image-panel">
            <div class="image-container">
                <img id="mainImage" src="" alt="Annotation Image" crossorigin="anonymous">
                <canvas id="canvas"></canvas>
            </div>
        </div>
        
        <div class="controls-panel">
            <div id="statusMessagesContainer"></div>

            <div class="control-group">
                <h3>Quick Load</h3>
                <div class="file-input-area">
                    <p>Drag & drop images and labels here<br>or use the buttons below</p>
                </div>
                <button onclick="requestDirectorySelection()">Select Directories</button>
            </div>

            <div class="control-group">
                <h3>Navigation & Actions</h3>
                <div class="navigation-controls">
                    <button id="prevBtn" title="Previous Image (Left Arrow)">‹ Prev</button>
                    <span id="imageInfo">No Image Loaded</span>
                    <button id="nextBtn" title="Next Image (Right Arrow)">Next ›</button>
                </div>
                <button id="addLabelBtn" title="Start drawing a new label (A)">Add New Label</button>
                <button id="saveBtn" title="Save all labels for current image (Ctrl+S)" style="margin-top:10px; background-color: #28a745;">Save Labels</button>
            </div>

            <div class="control-group">
                <h3>Edit Selected Label</h3>
                <div id="editFormContainer">
                    <p class="no-content">Select or create a label to edit.</p>
                </div>
            </div>

            <div class="control-group">
                <h3 id="currentLabelsHeader">Current Labels (0)</h3>
                <div id="labelListDisplay" style="max-height: 300px; overflow-y: auto;">
                     <p class="no-content">No labels yet for this image.</p>
                </div>
            </div>
        </div>
    </div>

    <script nonce="${nonce}">
        const vscode = acquireVsCodeApi();
        const imgElement = document.getElementById('mainImage');
        const canvas = document.getElementById('canvas');
        const ctx = canvas.getContext('2d');
        const dropZone = document.getElementById('dropZone');

        const prevBtn = document.getElementById('prevBtn');
        const nextBtn = document.getElementById('nextBtn');
        const imageInfoSpan = document.getElementById('imageInfo');
        const saveBtn = document.getElementById('saveBtn');
        const addLabelBtn = document.getElementById('addLabelBtn');
        const editFormContainer = document.getElementById('editFormContainer');
        const labelListDisplay = document.getElementById('labelListDisplay');
        const currentLabelsHeader = document.getElementById('currentLabelsHeader');
        const statusMessagesContainer = document.getElementById('statusMessagesContainer');

        let currentImageName = '';
        let currentLabels = []; 
        let currentClassNames = [];
        let selectedLabelIndex = -1; 
        let unsavedChanges = false;
        let isDrawing = false;
        let isDrawingMode = false; 
        let startX, startY, mouseX, mouseY; 
        let dragCounter = 0;

        // Drag and Drop functionality
        function setupDragAndDrop() {
            const container = document.querySelector('.container');
            
            ['dragenter', 'dragover', 'dragleave', 'drop'].forEach(eventName => {
                container.addEventListener(eventName, preventDefaults, false);
            });

            function preventDefaults(e) {
                e.preventDefault();
                e.stopPropagation();
            }

            container.addEventListener('dragenter', handleDragEnter);
            container.addEventListener('dragover', handleDragOver);
            container.addEventListener('dragleave', handleDragLeave);
            container.addEventListener('drop', handleDrop);

            function handleDragEnter(e) {
                dragCounter++;
                dropZone.classList.add('active');
            }

            function handleDragOver(e) {
                e.dataTransfer.dropEffect = 'copy';
            }

            function handleDragLeave(e) {
                dragCounter--;
                if (dragCounter === 0) {
                    dropZone.classList.remove('active');
                }
            }

            async function handleDrop(e) {
                dragCounter = 0;
                dropZone.classList.remove('active');
                
                const files = Array.from(e.dataTransfer.files);
                if (files.length === 0) return;

                const processedFiles = await Promise.all(files.map(async (file) => {
                    const filePath = file.path || file.name;
                    const fileName = file.name.toLowerCase();
                    let fileType;

                    if (fileName.includes('classes') && fileName.endsWith('.txt')) {
                        fileType = 'classes';
                    } else if (fileName.endsWith('.txt')) {
                        fileType = 'label';
                    } else if (fileName.match(/\\.(jpg|jpeg|png)$/i)) {
                        fileType = 'image';
                    } else {
                        return null;
                    }

                    return {
                        name: file.name,
                        path: filePath,
                        type: fileType,
                        content: fileType === 'classes' ? await readFileContent(file) : undefined
                    };
                }));

                const validFiles = processedFiles.filter(f => f !== null);
                
                if (validFiles.length === 0) {
                    showStatusMessage('No valid files found. Please drop images (.jpg, .png), labels (.txt), or classes.txt files.', 'error');
                    return;
                }

                vscode.postMessage({
                    command: 'filesDropped',
                    files: validFiles
                });
            }

            async function readFileContent(file) {
                return new Promise((resolve, reject) => {
                    const reader = new FileReader();
                    reader.onload = e => resolve(e.target.result);
                    reader.onerror = reject;
                    reader.readAsText(file);
                });
            }
        }

        function requestDirectorySelection() {
            vscode.postMessage({ command: 'requestDirectorySelection' });
        }

        function showStatusMessage(message, type = 'info', duration = 3000) {
            statusMessagesContainer.innerHTML = '';
            const messageDiv = document.createElement('div');
            messageDiv.className = \`status-message status-\${type}\`;
            messageDiv.textContent = message;
            statusMessagesContainer.appendChild(messageDiv);
            if (duration > 0) {
                setTimeout(() => {
                    if (statusMessagesContainer.contains(messageDiv)) {
                         statusMessagesContainer.removeChild(messageDiv);
                    }
                }, duration);
            }
        }

        // Handle messages from extension
        window.addEventListener('message', event => {
            const message = event.data;
            console.log('Received message:', message);
            
            switch(message.command) {
                case 'loadImage':
                    loadImageData(message);
                    break;
                case 'error':
                    showStatusMessage(message.message, 'error');
                    break;
                case 'noImagesFound':
                    showStatusMessage('No images found in the selected directory.', 'error', 0);
                    break;
                case 'labelsSaved':
                    showStatusMessage(\`Labels saved for \${message.imageName}\`, 'success');
                    unsavedChanges = false;
                    break;
                case 'updateNavButtons':
                    updateNavigationButtons(message.canGoPrev, message.canGoNext);
                    break;
            }
        });

        function loadImageData(data) {
            try {
                currentImageName = data.imageName;
                currentLabels = data.labels || [];
                currentClassNames = data.classes || [];

                imageInfoSpan.textContent = \`\${data.currentIndex + 1} / \${data.totalImages}\`;
                
                imgElement.onload = function() {
                    console.log('Image loaded successfully:', currentImageName);
                    setupCanvas();
                    updateUI();
                    redrawCanvas();
                };
                
                imgElement.onerror = function(e) {
                    console.error('Failed to load image:', data.imageUri, e);
                    showStatusMessage(\`Failed to load image: \${currentImageName}\`, 'error');
                };

                console.log('Setting image src to base64 data');
                imgElement.src = data.imageUri;
                
            } catch (error) {
                console.error('Error in loadImageData:', error);
                showStatusMessage('Error loading image data', 'error');
            }
        }

        function setupCanvas() {
            canvas.width = imgElement.naturalWidth;
            canvas.height = imgElement.naturalHeight;
            canvas.style.width = imgElement.offsetWidth + 'px';
            canvas.style.height = imgElement.offsetHeight + 'px';
        }

        function updateUI() {
            updateLabelsList();
            updateEditForm();
            updateNavigationButtons(true, true);
        }

        function updateLabelsList() {
            currentLabelsHeader.textContent = \`Current Labels (\${currentLabels.length})\`;
            
            if (currentLabels.length === 0) {
                labelListDisplay.innerHTML = '<p class="no-content">No labels yet for this image.</p>';
                return;
            }

            labelListDisplay.innerHTML = '';
            currentLabels.forEach((label, index) => {
                const div = document.createElement('div');
                div.className = 'label-item';
                if (index === selectedLabelIndex) {
                    div.classList.add('selected');
                }
                
                const className = currentClassNames[label.classId] || \`Class \${label.classId}\`;
                div.innerHTML = \`
                    <span>\${className}</span>
                    <button onclick="deleteLabel(\${index})" style="background-color: #dc3545; padding: 4px 8px; font-size: 12px;">Delete</button>
                \`;
                
                div.addEventListener('click', (e) => {
                    if (e.target.tagName !== 'BUTTON') {
                        selectLabel(index);
                    }
                });
                
                labelListDisplay.appendChild(div);
            });
        }

        function selectLabel(index) {
            selectedLabelIndex = index;
            updateLabelsList();
            updateEditForm();
            redrawCanvas();
        }

        function deleteLabel(index) {
            currentLabels.splice(index, 1);
            if (selectedLabelIndex >= index) {
                selectedLabelIndex = selectedLabelIndex > 0 ? selectedLabelIndex - 1 : -1;
            }
            unsavedChanges = true;
            updateUI();
            redrawCanvas();
        }

        function updateEditForm() {
            if (selectedLabelIndex === -1 || !currentLabels[selectedLabelIndex]) {
                editFormContainer.innerHTML = '<p class="no-content">Select or create a label to edit.</p>';
                return;
            }

            const label = currentLabels[selectedLabelIndex];
            editFormContainer.innerHTML = \`
                <label>Class:</label>
                <select id="classSelect">
                    \${currentClassNames.map((name, idx) => 
                        \`<option value="\${idx}" \${idx === label.classId ? 'selected' : ''}>\${name}</option>\`
                    ).join('')}
                </select>
                
                <label>Center X (0-1):</label>
                <input type="number" id="cxInput" value="\${label.cx.toFixed(6)}" step="0.000001" min="0" max="1">
                
                <label>Center Y (0-1):</label>
                <input type="number" id="cyInput" value="\${label.cy.toFixed(6)}" step="0.000001" min="0" max="1">
                
                <label>Width (0-1):</label>
                <input type="number" id="wInput" value="\${label.w.toFixed(6)}" step="0.000001" min="0" max="1">
                
                <label>Height (0-1):</label>
                <input type="number" id="hInput" value="\${label.h.toFixed(6)}" step="0.000001" min="0" max="1">
                
                <button onclick="updateSelectedLabel()" style="background-color: #28a745; margin-top: 10px;">Update Label</button>
            \`;
        }

        function updateSelectedLabel() {
            if (selectedLabelIndex === -1) return;

            const classSelect = document.getElementById('classSelect');
            const cxInput = document.getElementById('cxInput');
            const cyInput = document.getElementById('cyInput');
            const wInput = document.getElementById('wInput');
            const hInput = document.getElementById('hInput');

            currentLabels[selectedLabelIndex] = {
                classId: parseInt(classSelect.value),
                cx: parseFloat(cxInput.value),
                cy: parseFloat(cyInput.value),
                w: parseFloat(wInput.value),
                h: parseFloat(hInput.value)
            };

            unsavedChanges = true;
            updateLabelsList();
            redrawCanvas();
            showStatusMessage('Label updated', 'success', 2000);
        }

        function updateNavigationButtons(canGoPrev, canGoNext) {
            prevBtn.disabled = !canGoPrev;
            nextBtn.disabled = !canGoNext;
        }

        function redrawCanvas() {
            ctx.clearRect(0, 0, canvas.width, canvas.height);
            
            // Draw all labels
            currentLabels.forEach((label, index) => {
                const isSelected = index === selectedLabelIndex;
                drawBoundingBox(label, isSelected);
            });

            // Draw current drawing if in drawing mode
            if (isDrawing && isDrawingMode) {
                drawCurrentBox();
            }
        }

        function drawBoundingBox(label, isSelected) {
            const x = (label.cx - label.w / 2) * canvas.width;
            const y = (label.cy - label.h / 2) * canvas.height;
            const width = label.w * canvas.width;
            const height = label.h * canvas.height;

            ctx.strokeStyle = isSelected ? '#ff0000' : '#00ff00';
            ctx.lineWidth = isSelected ? 3 : 2;
            ctx.strokeRect(x, y, width, height);

            // Draw class label
            const className = currentClassNames[label.classId] || ('Class ' + label.classId);
            ctx.fillStyle = isSelected ? '#ff0000' : '#00ff00';
            ctx.font = '14px Arial';
            ctx.fillText(className, x, y - 5);
        }

        function drawCurrentBox() {
            if (!startX || !startY || !mouseX || !mouseY) return;

            const x = Math.min(startX, mouseX);
            const y = Math.min(startY, mouseY);
            const width = Math.abs(mouseX - startX);
            const height = Math.abs(mouseY - startY);

            ctx.strokeStyle = '#ffff00';
            ctx.lineWidth = 2;
            ctx.setLineDash([5, 5]);
            ctx.strokeRect(x, y, width, height);
            ctx.setLineDash([]);
        }

        function getCanvasCoordinates(event) {
            const rect = canvas.getBoundingClientRect();
            const scaleX = canvas.width / rect.width;
            const scaleY = canvas.height / rect.height;
            
            return {
                x: (event.clientX - rect.left) * scaleX,
                y: (event.clientY - rect.top) * scaleY
            };
        }

        function convertToYOLO(x, y, width, height) {
            return {
                cx: (x + width / 2) / canvas.width,
                cy: (y + height / 2) / canvas.height,
                w: width / canvas.width,
                h: height / canvas.height
            };
        }

        // Event listeners
        prevBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'requestPreviousImage' });
        });

        nextBtn.addEventListener('click', () => {
            vscode.postMessage({ command: 'requestNextImage' });
        });

        saveBtn.addEventListener('click', () => {
            vscode.postMessage({
                command: 'saveLabels',
                imageName: currentImageName,
                labels: currentLabels
            });
        });

        addLabelBtn.addEventListener('click', () => {
            isDrawingMode = !isDrawingMode;
            addLabelBtn.textContent = isDrawingMode ? 'Cancel Drawing' : 'Add New Label';
            addLabelBtn.style.backgroundColor = isDrawingMode ? '#dc3545' : '#007acc';
            canvas.style.cursor = isDrawingMode ? 'crosshair' : 'default';
            
            if (!isDrawingMode) {
                isDrawing = false;
                redrawCanvas();
            }
        });

        // Canvas mouse events
        canvas.addEventListener('mousedown', (e) => {
            if (!isDrawingMode) {
                // Check if clicking on an existing label
                const coords = getCanvasCoordinates(e);
                const clickedLabelIndex = findLabelAtPosition(coords.x, coords.y);
                if (clickedLabelIndex !== -1) {
                    selectLabel(clickedLabelIndex);
                }
                return;
            }

            const coords = getCanvasCoordinates(e);
            startX = coords.x;
            startY = coords.y;
            isDrawing = true;
        });

        canvas.addEventListener('mousemove', (e) => {
            if (!isDrawing || !isDrawingMode) return;

            const coords = getCanvasCoordinates(e);
            mouseX = coords.x;
            mouseY = coords.y;
            redrawCanvas();
        });

        canvas.addEventListener('mouseup', (e) => {
            if (!isDrawing || !isDrawingMode) return;

            const coords = getCanvasCoordinates(e);
            const x = Math.min(startX, coords.x);
            const y = Math.min(startY, coords.y);
            const width = Math.abs(coords.x - startX);
            const height = Math.abs(coords.y - startY);

            if (width > 5 && height > 5) { // Minimum size check
                const yoloCoords = convertToYOLO(x, y, width, height);
                
                const newLabel = {
                    classId: 0, // Default to first class
                    cx: yoloCoords.cx,
                    cy: yoloCoords.cy,
                    w: yoloCoords.w,
                    h: yoloCoords.h
                };

                currentLabels.push(newLabel);
                selectedLabelIndex = currentLabels.length - 1;
                unsavedChanges = true;
                
                updateUI();
                redrawCanvas();
                showStatusMessage('New label created', 'success', 2000);
            }

            isDrawing = false;
            isDrawingMode = false;
            addLabelBtn.textContent = 'Add New Label';
            addLabelBtn.style.backgroundColor = '#007acc';
            canvas.style.cursor = 'default';
        });

        function findLabelAtPosition(x, y) {
            for (let i = currentLabels.length - 1; i >= 0; i--) {
                const label = currentLabels[i];
                const labelX = (label.cx - label.w / 2) * canvas.width;
                const labelY = (label.cy - label.h / 2) * canvas.height;
                const labelWidth = label.w * canvas.width;
                const labelHeight = label.h * canvas.height;

                if (x >= labelX && x <= labelX + labelWidth && 
                    y >= labelY && y <= labelY + labelHeight) {
                    return i;
                }
            }
            return -1;
        }

        // Keyboard shortcuts
        document.addEventListener('keydown', (e) => {
            if (e.ctrlKey && e.key === 's') {
                e.preventDefault();
                saveBtn.click();
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                if (!prevBtn.disabled) prevBtn.click();
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                if (!nextBtn.disabled) nextBtn.click();
            } else if (e.key === 'a' || e.key === 'A') {
                e.preventDefault();
                addLabelBtn.click();
            } else if (e.key === 'Delete' && selectedLabelIndex !== -1) {
                e.preventDefault();
                deleteLabel(selectedLabelIndex);
            }
        });

        // Window resize handler
        window.addEventListener('resize', () => {
            if (imgElement.complete && imgElement.naturalWidth > 0) {
                setupCanvas();
                redrawCanvas();
            }
        });

        // Initialize drag and drop
        setupDragAndDrop();

        // Initialize
        console.log('Webview initialized, sending ready message');
        vscode.postMessage({ command: 'webviewReady' });
    </script>
</body>
</html>`;
}

function getNonce(): string {
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    for (let i = 0; i < 32; i++) {
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }
    return text;
}

export function deactivate() {
    console.log('YOLO Annotator extension is now deactivated.');
    if (state.webviewPanel) {
        state.webviewPanel.dispose();
    }
}