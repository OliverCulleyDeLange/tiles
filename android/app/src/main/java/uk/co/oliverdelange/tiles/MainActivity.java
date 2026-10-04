package uk.co.oliverdelange.tiles;

import com.getcapacitor.BridgeActivity;
import androidx.activity.OnBackPressedCallback;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(NearbyConnectionsPlugin.class);
        super.onCreate(savedInstanceState);
        getOnBackPressedDispatcher().addCallback(this, new OnBackPressedCallback(true) {
            @Override
            public void handleOnBackPressed() {
                if (bridge == null || bridge.getWebView() == null) {
                    finish();
                    return;
                }
                bridge.getWebView().evaluateJavascript(
                    "window.tilesHandleNativeBack ? Boolean(window.tilesHandleNativeBack()) : false",
                    handled -> {
                        if (!"true".equals(handled)) finish();
                    }
                );
            }
        });
    }
}
