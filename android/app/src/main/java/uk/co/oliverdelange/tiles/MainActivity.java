package uk.co.oliverdelange.tiles;

import com.getcapacitor.BridgeActivity;

public class MainActivity extends BridgeActivity {
    @Override
    public void onCreate(android.os.Bundle savedInstanceState) {
        registerPlugin(NearbyConnectionsPlugin.class);
        super.onCreate(savedInstanceState);
    }
}
