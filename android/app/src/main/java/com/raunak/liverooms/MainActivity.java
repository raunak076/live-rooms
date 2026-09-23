package com.raunak.liverooms;

import android.Manifest;
import android.app.Activity;
import android.content.ActivityNotFoundException;
import android.content.Intent;
import android.content.pm.PackageManager;
import android.graphics.Color;
import android.net.Uri;
import android.os.Build;
import android.os.Bundle;
import android.webkit.CookieManager;
import android.webkit.JavascriptInterface;
import android.webkit.PermissionRequest;
import android.webkit.ValueCallback;
import android.webkit.WebChromeClient;
import android.webkit.WebResourceRequest;
import android.webkit.WebSettings;
import android.webkit.WebView;
import android.webkit.WebViewClient;
import android.widget.Toast;

import java.util.ArrayList;
import java.util.List;

public class MainActivity extends Activity {
    private static final String APP_URL = "https://live-rooms-production.up.railway.app/";
    private static final String APP_HOST = "live-rooms-production.up.railway.app";
    private static final int WEB_PERMISSION_REQUEST = 1001;
    private static final int FILE_CHOOSER_REQUEST = 1002;
    private static final int NOTIFICATION_PERMISSION_REQUEST = 1003;

    private WebView webView;
    private boolean pageReady;
    private PermissionRequest pendingWebPermissionRequest;
    private ValueCallback<Uri[]> filePathCallback;
    private String pendingRoomId;
    private String pendingCallId;

    @Override
    protected void onCreate(Bundle savedInstanceState) {
        super.onCreate(savedInstanceState);
        getWindow().setStatusBarColor(Color.parseColor("#075e54"));

        webView = new WebView(this);
        webView.setBackgroundColor(Color.parseColor("#0b141a"));
        setContentView(webView);
        webView.addJavascriptInterface(new NativeBridge(), "LiveRoomsNative");
        captureNotificationIntent(getIntent());

        if (Build.VERSION.SDK_INT >= 33
                && checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) != PackageManager.PERMISSION_GRANTED) {
            requestPermissions(new String[]{Manifest.permission.POST_NOTIFICATIONS}, NOTIFICATION_PERMISSION_REQUEST);
        }

        WebSettings settings = webView.getSettings();
        settings.setJavaScriptEnabled(true);
        settings.setDomStorageEnabled(true);
        settings.setDatabaseEnabled(true);
        settings.setCacheMode(WebSettings.LOAD_DEFAULT);
        settings.setOffscreenPreRaster(true);
        settings.setMediaPlaybackRequiresUserGesture(false);
        settings.setAllowContentAccess(true);
        settings.setAllowFileAccess(true);
        settings.setMixedContentMode(WebSettings.MIXED_CONTENT_NEVER_ALLOW);
        settings.setUserAgentString(settings.getUserAgentString() + " LiveRoomsAndroid/1.1");

        CookieManager cookieManager = CookieManager.getInstance();
        cookieManager.setAcceptCookie(true);
        cookieManager.setAcceptThirdPartyCookies(webView, true);

        webView.setWebViewClient(new WebViewClient() {
            @Override
            public void onPageFinished(WebView view, String url) {
                super.onPageFinished(view, url);
                pageReady = true;
                wakeLiveSession();
                deliverNotificationIntent();
            }

            @Override
            public boolean shouldOverrideUrlLoading(WebView view, WebResourceRequest request) {
                Uri uri = request.getUrl();
                if ("https".equalsIgnoreCase(uri.getScheme()) && APP_HOST.equalsIgnoreCase(uri.getHost())) {
                    return false;
                }
                try {
                    startActivity(new Intent(Intent.ACTION_VIEW, uri));
                } catch (ActivityNotFoundException ignored) {
                    Toast.makeText(MainActivity.this, "No app can open this link.", Toast.LENGTH_SHORT).show();
                }
                return true;
            }
        });

        webView.setWebChromeClient(new WebChromeClient() {
            @Override
            public void onPermissionRequest(PermissionRequest request) {
                runOnUiThread(() -> handleWebPermissionRequest(request));
            }

            @Override
            public boolean onShowFileChooser(WebView view, ValueCallback<Uri[]> callback, FileChooserParams params) {
                if (filePathCallback != null) filePathCallback.onReceiveValue(null);
                filePathCallback = callback;
                Intent intent;
                try {
                    intent = params.createIntent();
                } catch (Exception exception) {
                    intent = new Intent(Intent.ACTION_GET_CONTENT);
                    intent.addCategory(Intent.CATEGORY_OPENABLE);
                    intent.setType("*/*");
                }
                try {
                    startActivityForResult(intent, FILE_CHOOSER_REQUEST);
                    return true;
                } catch (ActivityNotFoundException exception) {
                    filePathCallback = null;
                    Toast.makeText(MainActivity.this, "No file picker is available.", Toast.LENGTH_SHORT).show();
                    return false;
                }
            }
        });

        if (savedInstanceState == null) webView.loadUrl(APP_URL);
        else webView.restoreState(savedInstanceState);
    }

    private class NativeBridge {
        @JavascriptInterface public void startNotifications(String token,String username){if(token==null||!token.matches("[a-f0-9]{64}")||username==null||!username.matches("[a-z0-9_]{3,24}"))return;Intent service=new Intent(MainActivity.this,NotificationService.class).putExtra(NotificationService.EXTRA_TOKEN,token).putExtra(NotificationService.EXTRA_USERNAME,username);runOnUiThread(()->{if(Build.VERSION.SDK_INT>=Build.VERSION_CODES.O)startForegroundService(service);else startService(service);});}
        @JavascriptInterface public void stopNotifications(){getSharedPreferences(NotificationService.PREFS,MODE_PRIVATE).edit().clear().apply();runOnUiThread(()->stopService(new Intent(MainActivity.this,NotificationService.class)));}
    }
    private void captureNotificationIntent(Intent intent){if(intent==null)return;String roomId=intent.getStringExtra(NotificationService.EXTRA_ROOM_ID),callId=intent.getStringExtra(NotificationService.EXTRA_CALL_ID);if(roomId!=null&&roomId.matches("[a-f0-9]{24}"))pendingRoomId=roomId;if(callId!=null&&callId.matches("[a-f0-9-]{20,64}"))pendingCallId=callId;}
    private void deliverNotificationIntent(){if(!pageReady||pendingRoomId==null)return;String roomId=pendingRoomId,callId=pendingCallId==null?"":pendingCallId;pendingRoomId=null;pendingCallId=null;webView.evaluateJavascript("window.handleNativeNotification && window.handleNativeNotification('"+roomId+"','"+callId+"')",null);}
    @Override protected void onNewIntent(Intent intent){super.onNewIntent(intent);setIntent(intent);captureNotificationIntent(intent);deliverNotificationIntent();}

    private void wakeLiveSession() {
        if (webView == null || !pageReady) return;
        webView.evaluateJavascript(
                "window.handleNativeResume ? String(window.handleNativeResume()) : 'false'",
                null
        );
    }

    @Override
    protected void onResume() {
        super.onResume();
        getSharedPreferences(NotificationService.PREFS,MODE_PRIVATE).edit().putBoolean("app_foreground",true).apply();
        if (webView != null) webView.onResume();
        wakeLiveSession();
    }

    @Override
    protected void onPause() {
        getSharedPreferences(NotificationService.PREFS,MODE_PRIVATE).edit().putBoolean("app_foreground",false).apply();
        if (webView != null) webView.onPause();
        super.onPause();
    }

    private void handleWebPermissionRequest(PermissionRequest request) {
        List<String> missing = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)
                    && checkSelfPermission(Manifest.permission.RECORD_AUDIO) != PackageManager.PERMISSION_GRANTED) missing.add(Manifest.permission.RECORD_AUDIO);
            if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                    && checkSelfPermission(Manifest.permission.CAMERA) != PackageManager.PERMISSION_GRANTED) missing.add(Manifest.permission.CAMERA);
        }
        if (missing.isEmpty()) grantAllowedWebResources(request);
        else {
            pendingWebPermissionRequest = request;
            requestPermissions(missing.toArray(new String[0]), WEB_PERMISSION_REQUEST);
        }
    }

    private void grantAllowedWebResources(PermissionRequest request) {
        List<String> allowed = new ArrayList<>();
        for (String resource : request.getResources()) {
            if (PermissionRequest.RESOURCE_AUDIO_CAPTURE.equals(resource)
                    && checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED) allowed.add(resource);
            else if (PermissionRequest.RESOURCE_VIDEO_CAPTURE.equals(resource)
                    && checkSelfPermission(Manifest.permission.CAMERA) == PackageManager.PERMISSION_GRANTED) allowed.add(resource);
        }
        if (allowed.isEmpty()) request.deny();
        else request.grant(allowed.toArray(new String[0]));
    }

    @Override
    public void onRequestPermissionsResult(int requestCode, String[] permissions, int[] grantResults) {
        super.onRequestPermissionsResult(requestCode, permissions, grantResults);
        if (requestCode == WEB_PERMISSION_REQUEST && pendingWebPermissionRequest != null) {
            PermissionRequest request = pendingWebPermissionRequest;
            pendingWebPermissionRequest = null;
            grantAllowedWebResources(request);
        }
    }

    @Override
    protected void onActivityResult(int requestCode, int resultCode, Intent data) {
        super.onActivityResult(requestCode, resultCode, data);
        if (requestCode == FILE_CHOOSER_REQUEST && filePathCallback != null) {
            filePathCallback.onReceiveValue(WebChromeClient.FileChooserParams.parseResult(resultCode, data));
            filePathCallback = null;
        }
    }

    @Override
    protected void onSaveInstanceState(Bundle outState) {
        webView.saveState(outState);
        super.onSaveInstanceState(outState);
    }

    @Override
    public void onBackPressed() {
        if (webView == null) return;
        webView.evaluateJavascript(
                "window.handleNativeBack ? String(window.handleNativeBack()) : 'false'",
                handled -> {
                    if (handled != null && handled.contains("true")) return;
                    if (webView.canGoBack()) webView.goBack();
                    else moveTaskToBack(true);
                }
        );
    }

    @Override
    protected void onDestroy() {
        if (webView != null) webView.destroy();
        super.onDestroy();
    }
}
