package dev.pvault.app;

import android.annotation.SuppressLint;
import android.app.Activity;
import android.content.ClipData;
import android.content.ClipboardManager;
import android.content.ContentValues;
import android.content.Intent;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.os.Environment;
import android.provider.MediaStore;
import android.util.Base64;
import android.view.KeyEvent;
import android.webkit.JavascriptInterface;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebResourceResponse;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.io.ByteArrayInputStream;
import java.io.File;
import java.io.FileOutputStream;
import java.io.IOException;
import java.io.InputStream;
import java.io.OutputStream;
import java.util.HashMap;
import java.util.Map;

/**
 * pvault 的安卓壳。
 *
 * 职责只有一个：用一个 WebView 加载打进 APK 里的静态站点，并补上 WebView 天生
 * 缺失的三件事：① ES Module 需要的安全源 ② 选文件（账单导入）③ 存文件（备份导出）。
 *
 * 刻意零第三方依赖：不用 AndroidX、不用 AppCompat，全部用系统 API。
 */
public class MainActivity extends Activity {

    /** 虚拟域名。WebView 认定 https 为安全源，所以 WebCrypto、ES Module 都能正常用；
     *  真实内容由 shouldInterceptRequest 从 assets 里取，不产生任何网络请求。 */
    private static final String VIRTUAL_HOST = "appassets.androidplatform.net";
    private static final String START_URL = "https://" + VIRTUAL_HOST + "/www/index.html";
    private static final int REQ_FILE = 1001;

    /** 与 UA 标记、ShellBridge.shellVersion() 保持同一个值。 */
    private static final String SHELL_VERSION = "1.0";

    /**
     * 页面导出备份走的是 blob: + <a download> + click()，而 WebView 既不处理 blob 下载、
     * 也不会触发 DownloadListener —— 用户点「导出」会毫无反应。这里在页面侧钩住
     * HTMLAnchorElement.click，把 blob 读成 base64 交给 Java 落盘。
     * 不能靠监听 click 事件：那个 <a> 从未插入 DOM，事件不会冒泡到 document。
     */
    private static final String DOWNLOAD_HOOK_JS =
            "(function(){"
                    + "if(window.__pvaultDownloadHooked)return;"
                    + "window.__pvaultDownloadHooked=true;"
                    + "var orig=HTMLAnchorElement.prototype.click;"
                    + "HTMLAnchorElement.prototype.click=function(){"
                    + "var href=this.href||'';"
                    + "var isBlob=href.indexOf('blob:')===0;"
                    + "var isData=href.indexOf('data:')===0;"
                    + "if(!this.hasAttribute('download')||(!isBlob&&!isData)){"
                    + "return orig.apply(this,arguments);}"
                    + "var name=this.getAttribute('download')||'pvault-export.json';"
                    + "fetch(href).then(function(r){return r.blob();}).then(function(b){"
                    + "var fr=new FileReader();"
                    + "fr.onload=function(){"
                    + "var s=String(fr.result);var i=s.indexOf(',');"
                    + "PvaultShell.saveFile(name,i>=0?s.slice(i+1):'',b.type||'');};"
                    + "fr.readAsDataURL(b);"
                    + "}).catch(function(e){"
                    + "if(window.console)console.error('pvault export failed',e);"
                    + "});"
                    + "};"
                    + "})();";

    private WebView web;
    private ValueCallback<Uri[]> filePathCallback;

    @SuppressLint("SetJavaScriptEnabled")
    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);

        web = new WebView(this);
        WebSettings s = web.getSettings();
        s.setJavaScriptEnabled(true);
        s.setDomStorageEnabled(true);      // IndexedDB 的开关之一
        s.setDatabaseEnabled(true);        // IndexedDB 的另一半
        s.setAllowFileAccess(false);       // 我们不走 file://，关掉更安全
        s.setAllowContentAccess(true);     // 选文件时要能读 content://
        s.setSupportZoom(false);
        s.setBuiltInZoomControls(false);
        s.setMediaPlaybackRequiresUserGesture(true);
        // 在 UA 上盖个戳，页面脚本能在执行前就知道「我在安卓壳里」。
        // 比注入全局变量可靠：UA 在文档脚本运行前就已确定，而 evaluateJavascript
        // 最早也只能在页面开始加载后才注入，那时 main.js 早就跑完了。
        s.setUserAgentString(s.getUserAgentString() + " pvault-shell/" + SHELL_VERSION);

        web.setWebViewClient(new WebViewClient() {
            @Override
            public WebResourceResponse shouldInterceptRequest(WebView view, WebResourceRequest request) {
                return serveAsset(request.getUrl());
            }

            /** 页面内的外链交给系统浏览器，不在壳里打开。 */
            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri u = request.getUrl();
                if (VIRTUAL_HOST.equals(u.getHost())) return false;
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, u));
                } catch (Exception ignored) {
                }
                return true;
            }

            /** 每次页面加载完注入导出钩子。 */
            @Override
            public void onPageFinished(WebView view, String url) {
                view.evaluateJavascript(DOWNLOAD_HOOK_JS, null);
            }
        });

        web.setWebChromeClient(new WebChromeClient() {
            /** 账单导入要选 CSV 文件。不实现这个，页面上点「选择账单文件」会毫无反应。 */
            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback,
                                             FileChooserParams params) {
                if (filePathCallback != null) {
                    filePathCallback.onReceiveValue(null);
                }
                filePathCallback = callback;
                try {
                    Intent intent = params.createIntent();
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    startActivityForResult(intent, REQ_FILE);
                    return true;
                } catch (Exception e) {
                    filePathCallback = null;
                    return false;
                }
            }
        });

        web.addJavascriptInterface(new ShellBridge(), "PvaultShell");
        // 允许用 Chrome/Edge 的 devtools 远程调试这个 WebView（adb forward 到
        // webview_devtools_remote_<pid> 即可用 CDP 驱动页面）。自用应用，留着方便排查。
        WebView.setWebContentsDebuggingEnabled(true);
        web.loadUrl(START_URL);
        setContentView(web);
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        if (requestCode == REQ_FILE) {
            if (filePathCallback != null) {
                filePathCallback.onReceiveValue(
                        WebChromeClient.FileChooserParams.parseResult(resultCode, data));
                filePathCallback = null;
            }
            return;
        }
        super.onActivityResult(requestCode, resultCode, data);
    }

    @Override
    public boolean onKeyDown(int keyCode, KeyEvent event) {
        if (keyCode == KeyEvent.KEYCODE_BACK && web != null && web.canGoBack()) {
            web.goBack();
            return true;
        }
        return super.onKeyDown(keyCode, event);
    }

    // ——— 资源服务：把 assets/www 当成一个 https 站点喂给 WebView ———

    private WebResourceResponse serveAsset(Uri url) {
        if (!VIRTUAL_HOST.equals(url.getHost())) return null;
        String path = url.getPath();
        if (path == null) return null;
        // 防目录穿越
        if (path.contains("..")) return notFound();

        String assetPath = path.startsWith("/") ? path.substring(1) : path;
        if (assetPath.isEmpty() || assetPath.endsWith("/")) assetPath += "index.html";

        try {
            InputStream in = getAssets().open(assetPath);
            WebResourceResponse resp = new WebResourceResponse(mimeOf(assetPath), "utf-8", in);
            Map<String, String> headers = new HashMap<>();
            // 本地资源不需要缓存协商，但给 manifest/sw 一个明确的类型有好处
            headers.put("Cache-Control", "no-cache");
            resp.setResponseHeaders(headers);
            return resp;
        } catch (IOException e) {
            return notFound();
        }
    }

    private WebResourceResponse notFound() {
        return new WebResourceResponse("text/plain", "utf-8", 404, "Not Found",
                new HashMap<>(), new ByteArrayInputStream("not found".getBytes()));
    }

    /** MIME 必须准。尤其是 .js —— 类型不对，浏览器会拒绝执行 ES Module，整个 app 白屏。 */
    private String mimeOf(String p) {
        String lower = p.toLowerCase();
        if (lower.endsWith(".html") || lower.endsWith(".htm")) return "text/html";
        if (lower.endsWith(".js") || lower.endsWith(".mjs")) return "text/javascript";
        if (lower.endsWith(".css")) return "text/css";
        if (lower.endsWith(".json") || lower.endsWith(".map")) return "application/json";
        if (lower.endsWith(".webmanifest")) return "application/manifest+json";
        if (lower.endsWith(".svg")) return "image/svg+xml";
        if (lower.endsWith(".png")) return "image/png";
        if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
        if (lower.endsWith(".webp")) return "image/webp";
        if (lower.endsWith(".ico")) return "image/x-icon";
        if (lower.endsWith(".woff2")) return "font/woff2";
        if (lower.endsWith(".woff")) return "font/woff";
        if (lower.endsWith(".ttf")) return "font/ttf";
        if (lower.endsWith(".txt") || lower.endsWith(".csv")) return "text/plain";
        return "application/octet-stream";
    }

    // ——— 与页面之间的桥：把备份文件真正写到手机的「下载」目录 ———

    private class ShellBridge {
        /**
         * 页面里的导出用的是 blob: + <a download> + click()，而 WebView 不会处理
         * blob 下载（既不弹保存框也不落盘），点下去会毫无反应。所以页面侧注入了一小段
         * 脚本，把 blob 转成 base64 后走这里落盘。
         */
        @JavascriptInterface
        public void saveFile(String filename, String base64, String mime) {
            String name = (filename == null || filename.isEmpty()) ? "pvault-export.bin" : filename;
            byte[] data;
            try {
                data = Base64.decode(base64, Base64.DEFAULT);
            } catch (Exception e) {
                toast("导出失败：数据解码出错");
                return;
            }
            try {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                    ContentValues cv = new ContentValues();
                    cv.put(MediaStore.Downloads.DISPLAY_NAME, name);
                    cv.put(MediaStore.Downloads.MIME_TYPE, exportMimeOf(name, mime));
                    Uri uri = getContentResolver()
                            .insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, cv);
                    if (uri == null) throw new IOException("无法在下载目录创建文件");
                    try (OutputStream os = getContentResolver().openOutputStream(uri)) {
                        if (os == null) throw new IOException("无法写入下载目录");
                        os.write(data);
                    }
                } else {
                    File dir = Environment.getExternalStoragePublicDirectory(
                            Environment.DIRECTORY_DOWNLOADS);
                    if (!dir.exists() && !dir.mkdirs()) throw new IOException("无法创建下载目录");
                    try (FileOutputStream fos = new FileOutputStream(new File(dir, name))) {
                        fos.write(data);
                    }
                }
                toast("已保存到「下载」：" + name);
            } catch (Exception e) {
                toast("导出失败：" + e.getMessage());
            }
        }

        /**
         * 导出文件落盘时用的 MIME。以前这里写死 application/json —— 那是对的，因为当时
         * 只有加密备份一种出口。现在发票原件（OFD / PDF / 图片）也从这条桥出去，写死就会
         * 让 MediaStore 里留下「文件名 xxx.ofd、类型 application/json」这种自相矛盾的记录，
         * 而手机是按这个类型决定「用哪个 App 打开」的 —— OFD 阅读器可能压根不出现在候选列表里。
         *
         * 优先信页面给的 blob.type（它就是这份字节的真实类型），拿不到再按扩展名兜。
         */
        private String exportMimeOf(String name, String mime) {
            // application/octet-stream 等于「不知道」——选择器给 OFD / PDF 常常就是这个值，
            // 直接采用它，下面那套按扩展名兜底的逻辑就白写了。
            if (mime != null && !mime.isEmpty() && !"application/octet-stream".equals(mime)) {
                return mime;
            }
            String lower = (name == null ? "" : name).toLowerCase();
            if (lower.endsWith(".ofd")) return "application/ofd";
            if (lower.endsWith(".pdf")) return "application/pdf";
            if (lower.endsWith(".png")) return "image/png";
            if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
            if (lower.endsWith(".webp")) return "image/webp";
            if (lower.endsWith(".heic")) return "image/heic";
            if (lower.endsWith(".json")) return "application/json";
            return "application/octet-stream";
        }

        /** 页面可以用来问「我是不是在安卓壳里」，以便调整提示文案。 */
        @JavascriptInterface
        public boolean isAndroidShell() {
            return true;
        }

        /**
         * 写系统剪贴板。
         *
         * WebView 里 navigator.clipboard.writeText 会直接 reject —— 安卓 WebView 没有
         * 浏览器那套剪贴板权限模型。恢复码页只有一个「复制」按钮，而那串码只显示一次，
         * 复制不出来就只能手抄，所以这里直接调系统 ClipboardManager 兜底。
         */
        @JavascriptInterface
        public boolean copyText(String text) {
            if (text == null) return false;
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (cm == null) return false;
                cm.setPrimaryClip(ClipData.newPlainText("pvault", text));
                return true;
            } catch (Exception e) {
                return false;
            }
        }

        /**
         * 读系统剪贴板，用于「清空前先确认那串内容还是自己刚写进去的」。
         * 读不到（无权限、无内容、非前台）返回 null，页面侧据此选择不动它。
         */
        @JavascriptInterface
        public String readClipboardText() {
            try {
                ClipboardManager cm = (ClipboardManager) getSystemService(CLIPBOARD_SERVICE);
                if (cm == null || !cm.hasPrimaryClip()) return null;
                ClipData clip = cm.getPrimaryClip();
                if (clip == null || clip.getItemCount() == 0) return null;
                CharSequence cs = clip.getItemAt(0).coerceToText(MainActivity.this);
                return cs == null ? null : cs.toString();
            } catch (Exception e) {
                return null;
            }
        }

        @JavascriptInterface
        public String shellVersion() {
            return "1.0";
        }

        private void toast(String msg) {
            runOnUiThread(() -> Toast.makeText(MainActivity.this, msg, Toast.LENGTH_LONG).show());
        }
    }
}
