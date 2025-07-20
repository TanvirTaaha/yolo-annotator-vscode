import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import naturalCompare from 'natural-compare-lite';

interface LabelElement {
    classId: number;
    cx: number;
    cy: number;
    w: number;
    h: number;
}

interface DetectionElement {
    classId: number;
    cx: number;
    cy: number;
    w: number;
    h: number;
    conf: number;
}

interface ImageInfo {
    path: string;
    index: number;
    total: number;
    filename: string;
}

interface BatchElement {
    imageSource: string | vscode.Uri | null;
    labels: LabelElement[];
    detections: DetectionElement[];
    info: ImageInfo;
}

interface CacheItem {
    imagePath: string;
    imageIndex: number; // Index in the original imageFiles array
    base64Data: string;
    labels: LabelElement[];
    labelsMtime: number;
    detections: DetectionElement[];
}

export class ImagePreloader {
    private cache: CacheItem[] = []; // Sequential cache list
    private imageFiles: string[] = [];
    private currentIndex = 0;
    private preloadRadius = { next: 3, prev: 2 }; // Default values
    private isPreloading = false;
    private keepBuffer = 5; // Number of images to keep in cache around current position

    constructor(private webview: vscode.Webview) { }

    // Initialize with directory and set current image
    public async initialize(directoryPath: string, currentImagePath: string, prevCount = 2, nextCount = 3, keepBuffer = 5): Promise<void> {
        this.preloadRadius = { next: nextCount, prev: prevCount };
        this.keepBuffer = keepBuffer;

        // Get all image files from directory
        const files = await fs.promises.readdir(directoryPath);
        this.imageFiles = files
            .filter(file => /\.(jpg|jpeg|png|bmp|webp)$/i.test(file))
            .map(file => path.join(directoryPath, file))
            .sort((a, b) => naturalCompare(a.toLowerCase(), b.toLowerCase())); // Sort for consistent ordering

        // Find current image index
        this.currentIndex = this.imageFiles.findIndex(file => file === currentImagePath);
        if (this.currentIndex === -1) {
            this.currentIndex = 0;
        }

        // Start preloading around current image
        await this.preloadAroundCurrent();
    }

    //Get the current Image path
    public getCurrentImagePath(): string {
        return this.imageFiles[this.currentIndex];
    }

    // Find cache item by image index
    private findCacheItem(imageIndex: number): CacheItem | undefined {
        return this.cache.find(item => item.imageIndex === imageIndex);
    }

    // Find cache item by image path
    private findCacheItemByPath(imagePath: string): CacheItem | undefined {
        return this.cache.find(item => item.imagePath === imagePath);
    }

    public updateCurrentIndex(imageFilename: string): void {
        this.currentIndex = this.imageFiles.findIndex((imagePath) => path.basename(imagePath) === imageFilename);
    }

    public getCurrentIndex(): number {
        return this.currentIndex;
    }

    public setCurrentIndex(index: number) {
        this.currentIndex = index;
    }

    // Get HTML for current image (instant if cached)
    public getCurrentImageSource(): string | vscode.Uri | null {
        const currentImage = this.imageFiles[this.currentIndex];
        if (!currentImage) { return null; }

        const cached = this.findCacheItem(this.currentIndex);
        if (cached) {
            return cached.base64Data;
        }

        // Fallback to webview URI if not cached yet
        const imageUri = vscode.Uri.file(currentImage);
        const webviewUri = this.webview.asWebviewUri(imageUri);
        return webviewUri;
    }

    // Navigate to next image
    public async goToNext(): Promise<string | vscode.Uri | null> {
        if (this.currentIndex < this.imageFiles.length - 1) {
            this.currentIndex++;
            await this.preloadAroundCurrent();
        }
        return this.getCurrentImageSource();
    }

    // Navigate to previous image
    public async goToPrevious(): Promise<string | vscode.Uri | null> {
        if (this.currentIndex > 0) {
            this.currentIndex--;
            await this.preloadAroundCurrent();
        }
        return this.getCurrentImageSource();
    }

    // Jump to specific index
    public async goToIndex(index: number): Promise<string | vscode.Uri | null> {
        if (index >= 0 && index < this.imageFiles.length) {
            this.currentIndex = index;
            await this.preloadAroundCurrent();
        }
        return this.getCurrentImageSource();
    }

    // Get current image info
    public getCurrentImageInfo(): ImageInfo {
        return this.getImageInfo(this.currentIndex);
    }

    public getImageInfo(index: number): ImageInfo {
        const imagePath = this.imageFiles[index] || '';
        return {
            path: imagePath,
            index: index,
            total: this.imageFiles.length,
            filename: path.basename(imagePath)
        };
    }

    // Preload images around current position
    private async preloadAroundCurrent(): Promise<void> {
        if (this.isPreloading) { return; }
        this.isPreloading = true;

        try {
            const indicesToPreload: number[] = [];

            // Add current image index
            indicesToPreload.push(this.currentIndex);

            // Add next image indices
            for (let i = 1; i <= this.preloadRadius.next; i++) {
                const nextIndex = this.currentIndex + i;
                if (nextIndex < this.imageFiles.length) {
                    indicesToPreload.push(nextIndex);
                }
            }

            // Add previous image indices
            for (let i = 1; i <= this.preloadRadius.prev; i++) {
                const prevIndex = this.currentIndex - i;
                if (prevIndex >= 0) {
                    indicesToPreload.push(prevIndex);
                }
            }

            // Filter out already cached indices
            const uncachedIndices = indicesToPreload.filter(index => !this.findCacheItem(index));
            if (uncachedIndices.length > 0) {
                await this.preloadImages(uncachedIndices);
            }

            // Clean up old cached images to manage memory
            this.cleanupDistantImages();

        } finally {
            this.isPreloading = false;
        }
    }

    // Preload specific images by indices
    private async preloadImages(imageIndices: number[]): Promise<void> {
        const loadPromises = imageIndices.map(async (imageIndex) => {
            try {
                const imagePath = this.imageFiles[imageIndex];

                // Load image data
                const buffer = await fs.promises.readFile(imagePath);
                const base64 = buffer.toString('base64');
                const mimeType = this.getMimeType(imagePath);
                const dataUrl = `data:${mimeType};base64,${base64}`;
                // Load labels data
                const labels = await this.loadLabelsForImage(imagePath);
                const labelsMtime = await this.getFileModTime(this.getLabelsPath(imagePath));
                const detections = await this.loadDetectionsForImage(imagePath);
                
                // Create cache item
                const cacheItem: CacheItem = {
                    imagePath,
                    imageIndex,
                    base64Data: dataUrl,
                    labels,
                    labelsMtime,
                    detections
                };

                // Insert cache item in correct position to maintain sequence
                this.insertCacheItemInOrder(cacheItem);

            } catch (error) {
                console.warn(`Failed to preload image at index ${imageIndex}:`, error);
            }
        });

        await Promise.all(loadPromises);
    }

    // Insert cache item maintaining the sequential order
    private insertCacheItemInOrder(newItem: CacheItem): void {
        const insertIndex = this.cache.findIndex(item => item.imageIndex > newItem.imageIndex);

        if (insertIndex === -1) {
            // Insert at the end
            this.cache.push(newItem);
        } else {
            // Insert at the correct position
            this.cache.splice(insertIndex, 0, newItem);
        }
    }

    // Clean up images that are far from current position to manage memory
    private cleanupDistantImages(): void {
        const minKeepIndex = Math.max(0, this.currentIndex - (this.preloadRadius.prev + this.keepBuffer));
        const maxKeepIndex = Math.min(this.imageFiles.length - 1, this.currentIndex + (this.preloadRadius.next + this.keepBuffer));

        // Filter cache to keep only items within the keep range
        this.cache = this.cache.filter(item =>
            item.imageIndex >= minKeepIndex && item.imageIndex <= maxKeepIndex
        );
    }

    // Get MIME type for image
    private getMimeType(filePath: string): string {
        const ext = path.extname(filePath).toLowerCase();
        const mimeTypes: { [key: string]: string } = {
            '.jpg': 'image/jpeg',
            '.jpeg': 'image/jpeg',
            '.png': 'image/png',
            '.bmp': 'image/bmp',
            '.webp': 'image/webp'
        };
        return mimeTypes[ext] || 'image/jpeg';
    }

    // Get cache status for debugging - EXACT SAME BEHAVIOR
    public getCacheStatus(): { cached: number; total: number; currentCached: boolean } {
        const currentCached = this.findCacheItem(this.currentIndex) !== undefined;
        return {
            cached: this.cache.length,
            total: this.imageFiles.length,
            currentCached
        };
    }

    private getLabelsPath(imagePath: string): string {
        const dir = path.dirname(imagePath);
        const name = path.basename(imagePath, path.extname(imagePath));

        const sameFolderLabels = path.join(dir, `${name}.txt`);
        if (fs.existsSync(sameFolderLabels)) {
            return sameFolderLabels;
        }

        const dir_parts = dir.split(path.sep);
        const lastImagesFolderIndex = dir_parts.lastIndexOf('images');
        if (lastImagesFolderIndex !== -1) {
            dir_parts[lastImagesFolderIndex] = 'labels';
        }
        const labelsDir = dir_parts.join(path.sep);

        return path.join(labelsDir, `${name}.txt`);
    }

    private getDetectionsPath(imagePath: string): string {
        const dir = path.dirname(imagePath);
        const name = path.basename(imagePath, path.extname(imagePath));

        const sameFolderDetections = path.join(dir, `${name}.det.txt`);
        if (fs.existsSync(sameFolderDetections)) {
            return sameFolderDetections;
        }

        const dir_parts = dir.split(path.sep);
        const lastImagesFolderIndex = dir_parts.lastIndexOf('images');
        if (lastImagesFolderIndex !== -1) {
            dir_parts[lastImagesFolderIndex] = 'detections';
        }
        const detectionsDir = dir_parts.join(path.sep);

        return path.join(detectionsDir, `${name}.det.txt`);
    }

    private async getFileModTime(filePath: string): Promise<number> {
        try {
            const stats = await fs.promises.stat(filePath);
            return stats.mtime.getTime();
        } catch {
            return 0;
        }
    }

    private getLabelCacheKey(imagePath: string): string {
        const labelPath = this.getLabelsPath(imagePath);
        return `labels_${path.basename(labelPath)}`;
    }

    private async loadLabelsForImage(imagePath: string): Promise<LabelElement[]> {
        try {
            const labelPath = this.getLabelsPath(imagePath);

            // Check if we have cached labels that are still valid
            const cachedItem = this.findCacheItemByPath(imagePath);
            if (cachedItem) {
                const currentMtime = await this.getFileModTime(labelPath);
                if (cachedItem.labelsMtime >= currentMtime) {
                    return cachedItem.labels;
                }
            }

            if (!fs.existsSync(labelPath)) {
                console.warn(`labels.txt not found for ${imagePath}`);
                return [];
            }

            const labelContent = await fs.promises.readFile(labelPath, 'utf-8');
            const labels = labelContent
                .trim().split('\n')
                .filter(line => line.trim())
                .map(line => {
                    const parts = line.split(' ').filter(part => part.trim());
                    if (parts.length === 5){
                        return {
                            classId: parseInt(parts[0]),
                            cx: parseFloat(parts[1]),
                            cy: parseFloat(parts[2]),
                            w: parseFloat(parts[3]),
                            h: parseFloat(parts[4])
                        };
                    } else {
                        return null;
                    }
                })
                .filter(lbl => lbl !== null);
            return labels;
        } catch (error) {
            console.warn(`labels.txt not found for ${imagePath}`);
            return [];
        }
    }

    private async loadDetectionsForImage(imagePath: string): Promise<DetectionElement[]> {
        try {
            // Check if we have cached detections
            const cachedItem = this.findCacheItemByPath(imagePath);
            if (cachedItem && cachedItem.detections) {
                return cachedItem.detections;
            }
            
            const detectionPath = this.getDetectionsPath(imagePath);
            if (!fs.existsSync(detectionPath)) {
                return [];
            }

            const detectContent = await fs.promises.readFile(detectionPath, 'utf-8');
            const detections = detectContent
                .trim().split('\n')
                .filter(line => line.trim())
                .map(line => {
                    const parts = line.split(' ').filter(part => part.trim());
                    if (parts.length === 6) {
                        return {
                            classId: parseInt(parts[0]),
                            cx: parseFloat(parts[1]),
                            cy: parseFloat(parts[2]),
                            w: parseFloat(parts[3]),
                            h: parseFloat(parts[4]),
                            conf: parseFloat(parts[5])
                        };
                    } else {
                        return null;
                    }
                })
                .filter(det => det !== null);
            return detections;
        } catch (error) {
            return [];
        }
    }

    public getCurrentDetection(): Promise<DetectionElement[]> {
        const cachedItem = this.findCacheItem(this.currentIndex);
        if (cachedItem) {
            return Promise.resolve(cachedItem.detections);
        }
        
        const currentPath = this.imageFiles[this.currentIndex];
        return this.loadDetectionsForImage(currentPath);
    }

    public getCurrentLabel(): Promise<LabelElement[]> {
        const cachedItem = this.findCacheItem(this.currentIndex);
        if (cachedItem) {
            return Promise.resolve(cachedItem.labels);
        }
        
        const currentPath = this.imageFiles[this.currentIndex];
        return this.loadLabelsForImage(currentPath);
    }

    // Additional method for synchronous access to cached labels (if needed for backward compatibility)
    public getCurrentLabelSync(): LabelElement[] {
        const cachedItem = this.findCacheItem(this.currentIndex);
        return cachedItem ? cachedItem.labels : [];
    }

    // EXACT SAME BEHAVIOR - maintains compatibility with existing usage
    public removeLabelCache(imagePath: string) {
        const cachedItem = this.findCacheItemByPath(imagePath);
        if (cachedItem) {
            // Reset labels data to trigger reload
            cachedItem.labels = [];
            cachedItem.labelsMtime = 0;
        }
    }

    // EXACT SAME BEHAVIOR - returns boolean
    public async saveLabelsForImage(imageFilename: string, labels: any[]): Promise<{ result: Boolean, cacheItem: CacheItem | undefined }> {
        try {
            const savedFileIndex = this.imageFiles.findIndex((p) => path.basename(p) === imageFilename);
            const imagePath = this.imageFiles[savedFileIndex];
            const labelPath = this.getLabelsPath(imagePath);
            const content = labels
                .map(l => `${l.classId} ${l.cx.toFixed(6)} ${l.cy.toFixed(6)} ${l.w.toFixed(6)} ${l.h.toFixed(6)}`)
                .join('\n');

            await fs.promises.mkdir(path.dirname(labelPath), { recursive: true });
            await fs.promises.writeFile(labelPath, content);

            // Update cached labels
            const cachedItem = this.findCacheItem(savedFileIndex);
            if (cachedItem) {
                cachedItem.labels = labels.map(l => ({
                    classId: l.classId,
                    cx: l.cx,
                    cy: l.cy,
                    w: l.w,
                    h: l.h
                }));
                cachedItem.labelsMtime = await this.getFileModTime(labelPath);
            }

            return { result: true, cacheItem: cachedItem };
        } catch (error) {
            console.error(error);
            return { result: false, cacheItem: undefined };
        }
    }

    public async getImageAndLabelBatchWithoutCurrentKeys(currentKeys: number[]): Promise<{ batch: Map<number, BatchElement> }> {
        const batch: Map<number, BatchElement> = new Map();
        this.cache.map((cacheItem) => {
            if (!currentKeys.includes(cacheItem.imageIndex)) {
                const info = this.getImageInfo(cacheItem.imageIndex);
                batch.set(info.index, {
                    imageSource: cacheItem.base64Data,
                    labels: cacheItem.labels,
                    detections: cacheItem.detections,
                    info: info
                });
            }
        });

        return { batch: batch };
    }

    public setKeepBuffer(keepBuffer: number) {
        this.keepBuffer = keepBuffer;
    }

    public updatePreloadRadius(previous: number, next: number) {
        this.preloadRadius.prev = previous;
        this.preloadRadius.next = next;
    }
}