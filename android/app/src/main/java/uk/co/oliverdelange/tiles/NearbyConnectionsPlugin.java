package uk.co.oliverdelange.tiles;

import android.Manifest;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.google.android.gms.nearby.Nearby;
import com.google.android.gms.nearby.connection.AdvertisingOptions;
import com.google.android.gms.nearby.connection.ConnectionInfo;
import com.google.android.gms.nearby.connection.ConnectionLifecycleCallback;
import com.google.android.gms.nearby.connection.ConnectionResolution;
import com.google.android.gms.nearby.connection.ConnectionsClient;
import com.google.android.gms.nearby.connection.DiscoveredEndpointInfo;
import com.google.android.gms.nearby.connection.DiscoveryOptions;
import com.google.android.gms.nearby.connection.EndpointDiscoveryCallback;
import com.google.android.gms.nearby.connection.Payload;
import com.google.android.gms.nearby.connection.PayloadCallback;
import com.google.android.gms.nearby.connection.PayloadTransferUpdate;
import com.google.android.gms.nearby.connection.Strategy;

import java.nio.charset.StandardCharsets;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

@CapacitorPlugin(
    name = "NearbyConnections",
    permissions = @Permission(
        alias = "nearby",
        strings = {
            Manifest.permission.ACCESS_FINE_LOCATION,
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.BLUETOOTH_SCAN,
            Manifest.permission.NEARBY_WIFI_DEVICES
        }
    )
)
public class NearbyConnectionsPlugin extends Plugin {
    private static final String SERVICE_ID = "uk.co.oliverdelange.tiles.nearby";
    private final Map<String, String> endpointNames = new HashMap<>();
    private final Map<String, java.util.function.Consumer<Boolean>> verifications = new HashMap<>();
    private ConnectionsClient client;

    @Override
    public void load() {
        client = Nearby.getConnectionsClient(getContext());
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", true);
        call.resolve(result);
    }

    @PluginMethod
    public void startAdvertising(PluginCall call) {
        String name = call.getString("name", "Tiles player");
        client.startAdvertising(name, SERVICE_ID, lifecycle,
                new AdvertisingOptions.Builder().setStrategy(Strategy.P2P_STAR).build())
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(error -> call.reject(error.getMessage(), error));
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        client.startDiscovery(SERVICE_ID, discovery,
                new DiscoveryOptions.Builder().setStrategy(Strategy.P2P_STAR).build())
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(error -> call.reject(error.getMessage(), error));
    }

    @PluginMethod
    public void requestConnection(PluginCall call) {
        String endpointId = call.getString("endpointId");
        String name = call.getString("name", "Tiles player");
        if (endpointId == null) { call.reject("endpointId is required"); return; }
        client.requestConnection(name, endpointId, lifecycle)
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(error -> call.reject(error.getMessage(), error));
    }

    @PluginMethod
    public void acceptVerification(PluginCall call) {
        String endpointId = call.getString("endpointId");
        boolean accept = Boolean.TRUE.equals(call.getBoolean("accept"));
        if (endpointId == null || !verifications.containsKey(endpointId)) { call.reject("No pending verification"); return; }
        verifications.remove(endpointId).accept(accept);
        call.resolve();
    }

    @PluginMethod
    public void send(PluginCall call) {
        JSArray ids = call.getArray("endpointIds", new JSArray());
        String payload = call.getString("payload", "");
        List<String> endpoints = new ArrayList<>();
        try { for (Object value : ids.toList()) endpoints.add(String.valueOf(value)); }
        catch (Exception error) { call.reject("Invalid endpointIds", error); return; }
        client.sendPayload(endpoints, Payload.fromBytes(payload.getBytes(StandardCharsets.UTF_8)))
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(error -> call.reject(error.getMessage(), error));
    }

    @PluginMethod
    public void disconnect(PluginCall call) {
        String endpointId = call.getString("endpointId");
        if (endpointId != null) client.disconnectFromEndpoint(endpointId);
        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        client.stopAdvertising();
        client.stopDiscovery();
        client.stopAllEndpoints();
        call.resolve();
    }

    private JSObject endpoint(String id) {
        JSObject value = new JSObject();
        value.put("endpointId", id);
        value.put("name", endpointNames.getOrDefault(id, "Nearby player"));
        return value;
    }

    private final EndpointDiscoveryCallback discovery = new EndpointDiscoveryCallback() {
        @Override public void onEndpointFound(String id, DiscoveredEndpointInfo info) {
            endpointNames.put(id, info.getEndpointName());
            notifyListeners("endpointFound", endpoint(id));
        }
        @Override public void onEndpointLost(String id) { notifyListeners("endpointLost", endpoint(id)); }
    };

    private final ConnectionLifecycleCallback lifecycle = new ConnectionLifecycleCallback() {
        @Override public void onConnectionInitiated(String id, ConnectionInfo info) {
            endpointNames.put(id, info.getEndpointName());
            JSObject value = endpoint(id);
            value.put("code", info.getAuthenticationDigits());
            verifications.put(id, accept -> {
                if (accept) client.acceptConnection(id, payloads);
                else client.rejectConnection(id);
            });
            notifyListeners("verificationRequired", value);
        }
        @Override public void onConnectionResult(String id, ConnectionResolution resolution) {
            if (resolution.getStatus().isSuccess()) notifyListeners("connected", endpoint(id));
            else notifyListeners("disconnected", endpoint(id));
        }
        @Override public void onDisconnected(String id) { notifyListeners("disconnected", endpoint(id)); }
    };

    private final PayloadCallback payloads = new PayloadCallback() {
        @Override public void onPayloadReceived(String id, Payload payload) {
            byte[] bytes = payload.asBytes();
            if (bytes == null) return;
            JSObject value = endpoint(id);
            value.put("payload", new String(bytes, StandardCharsets.UTF_8));
            notifyListeners("payloadReceived", value);
        }
        @Override public void onPayloadTransferUpdate(String id, PayloadTransferUpdate update) {}
    };
}
