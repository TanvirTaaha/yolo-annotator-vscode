# YOLO Annotator

Visual annotation tool for creating YOLO object detection datasets in VS Code.

<div align=center>
    <img src="https://raw.githubusercontent.com/TanvirTaaha/yolo-annotator-vscode/refs/heads/main/assets/icon128.png">
</div>

## Features

- **Visual Annotation**: Draw bounding boxes directly on images
- **YOLO Format**: Export annotations in standard YOLO `.txt` format
- **Class Management**: Support for custom class definitions via `classes.txt`
- **Keyboard Shortcuts**: Efficient workflow with hotkeys
- **Batch Processing**: Navigate through image directories seamlessly
- **Real-time Editing**: Modify existing annotations with live preview

## Installation

1. Open VS Code
2. Go to Extensions (Ctrl+Shift+X)
3. Search "YOLO Annotator"
4. Click Install

## Usage

### Quick Start

1. Right Click on any image and select "Open with YOLO Annotator"
2. Make sure to have a `classes.txt` file somewhere in the file structure shown below.
3. If labels are found you should see labels drawn on your image.
4. Use the navigation panel on the top-right or keyboard shortcuts to browse through images.

### Keyboard Shortcuts

- `A` - Add new label (drawing mode)
- `←/→` - Navigate between images
- `Ctrl+S` - Save current labels
- `Delete/Backspace` - Delete selected label
- `Esc` - Cancel drawing mode

### File Structure

```markdown
project/
├── images/
│   ├── image1.jpg
│   ├── image2.jpg
│   └── ...
├── labels/
│   ├── image1.txt
│   ├── image2.txt
│   └── ...
└── classes.txt
```

### classes.txt Format

```markdown
person
car
bicycle
dog
cat
```

### Output Format

Each `.txt` file contains one line per object:

```markdown
class_id center_x center_y width height
0 0.5 0.5 0.3 0.4
1 0.2 0.3 0.1 0.2
```

## Requirements

- VS Code 1.100.0 or higher
- Image files in JPG, PNG, or JPEG format

## Contributing

1. Fork the repository
2. Create a feature branch
3. Make your changes
4. Submit a pull request

## License

MIT License - see LICENSE file for details.

## Support

Report issues at: [https://github.com/TanvirTaaha/yolo-annotator-vscode/issues]("https://github.com/TanvirTaaha/yolo-annotator-vscode/issues")
