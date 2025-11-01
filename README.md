# 🧘 Mindful Web - Chrome Extension

Welcome to Mindful Web, a Chrome extension designed to help you browse with intention—whether you need to calm your mind or sharpen your focus.

## Features

### Calm Mode
- Calm Summarize: Get gentle, calming summaries of any web page.
- Breathe: Follow a guided breathing exercise with soothing visuals.
- Affirm Me: Receive gentle, encouraging affirmations.

### Focus Mode
- Set Intent: Define your browsing goal for the session.
- Usefulness Score: Instantly see how relevant a page is to your goal.
- Refocus Me: Get reminders to stay on track if you drift.

### Auto-Detection
- The extension can suggest Focus mode if it detects rapid tab switching.
- You can toggle this feature on or off in the popup.

---

## Installation

### Load as Unpacked Extension (for development)

1. Download or clone this repository.
2. Open Chrome and go to `chrome://extensions/`.
3. Enable "Developer mode" (top right).
4. Click "Load unpacked" and select the `mindful-web-extension` folder.
5. The extension should now appear in your extensions list.

### Token Requirements

- **Summarizer API**  
  - Works natively in Chrome 138 and above.  
  - **No token required.**

- **Prompt API**  
  - Also shipped in Chrome 138 and above.  
  - **No token required.**

- **Rewriter API**  
  - Still in Origin Trial (experimental).  
  - **Requires an Origin Trial token** for access.  
  - Added for origin https://anushkaratnaparkhi.github.io
    ```html
    <meta http-equiv="origin-trial" content="Ai4Z74hX0/WBdK9qjJi+R9BIBodgmF6cdVci/n3vH/COgu6zzBTMPi4p1RM8KoujZ+rv1ZPCHbm3H823p3aAHQ4AAABjeyJvcmlnaW4iOiJodHRwczovL2FudXNoa2FyYXRuYXBhcmtoaS5naXRodWIuaW86NDQzIiwiZmVhdHVyZSI6IkFJUmV3cml0ZXJBUEkiLCJleHBpcnkiOjE3NzY3Mjk2MDB9">
    ```
  - Without this token, only the Summarizer and Prompt features will work.


### Icons

You'll need the following PNG icons in the `icons/` directory:
- `icon16.png` (16x16)
- `icon48.png` (48x48)
- `icon128.png` (128x128)

If you don't have these, you can use the provided `icon.svg` and convert it to PNG, or use a placeholder image.


## How to Use

1. Click the Mindful Web icon in your Chrome toolbar.
2. Choose Calm Mode or Focus Mode.
3. Use the feature buttons to activate Calm Summarize, Breathe, Journal, or check Usefulness Score.

Tips:
- In Focus Mode, set your intent first for best results.
- The sidebar can be collapsed and dragged vertically for minimal distraction.
- Calm and Focus modes have distinct color themes for easy recognition.

---

## Technical Details

- Manifest V3: Uses the latest Chrome extension architecture.
- Content Scripts: Interact with web pages and Chrome's AI APIs.
- Background Service Worker: Monitors tab switching for distraction detection.
- Popup UI: Clean, modern interface with Calm (lavender) and Focus (teal) themes.

### File Structure

```
mindful-web-extension/
├── manifest.json          # Extension configuration
├── popup.html             # Popup UI structure
├── popup.css              # Popup styling
├── popup.js               # Popup logic
├── content.js             # Content script with AI interactions
├── styles.css             # Overlay and animation styles
├── background.js          # Background service worker
├── icons/                 # Extension icons
│   ├── icon.svg          # SVG source (convert to PNG)
│   ├── icon16.png        # 16x16 icon (required)
│   ├── icon48.png        # 48x48 icon (required)
│   └── icon128.png       # 128x128 icon (required)
└── README.md             # This file
```

---

## Privacy & Security

- All AI processing happens **locally** using Chrome's built-in APIs.
- No external API calls or data transmission.
- No user data is collected or stored externally.
- All settings are stored locally in Chrome's storage.

---

## Customization

- Colors: You can change the Calm and Focus color themes in `styles.css` and `popup.css`.
- Breathing Pattern: The breathing exercise uses a 4-3-4 pattern (inhale, hold, exhale). You can adjust this in `content.js` in the `startBreathingAnimation` function.

---

## Troubleshooting

- Extension Not Loading: Make sure all icon files exist and `manifest.json` is valid.
- AI Features Not Working: Chrome's AI APIs are experimental and may not be available in all versions.
- Features Not Appearing: Refresh the page after installing the extension. Check the browser console for errors.

---

## Development

1. Edit the relevant files in the extension directory.
2. Go to `chrome://extensions/` and click the refresh icon on the Mindful Web extension card.
3. Test your changes in Chrome.

Debugging Tips:
- Right-click the extension icon and select "Inspect popup" to debug the popup UI.
- Use DevTools on any page to debug the content script.
- Check the background service worker in `chrome://extensions/`.

---

## License

This project is open source and available for personal and educational use.

---

Built with ❤️ for a more mindful web experience.

