package uk.co.oliverdelange.tiles;

import android.Manifest;
import android.app.NotificationChannel;
import android.app.NotificationManager;
import android.app.PendingIntent;
import android.content.Context;
import android.content.Intent;
import android.os.Build;
import android.view.WindowManager;

import com.getcapacitor.JSArray;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.PermissionState;
import com.getcapacitor.annotation.CapacitorPlugin;
import com.getcapacitor.annotation.Permission;
import com.getcapacitor.annotation.PermissionCallback;
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
import java.util.HashSet;
import java.util.List;
import java.util.Map;

@CapacitorPlugin(
    name = "NearbyConnections",
    permissions = {
        @Permission(alias = "location", strings = { Manifest.permission.ACCESS_FINE_LOCATION }),
        @Permission(alias = "bluetooth", strings = {
            Manifest.permission.BLUETOOTH_ADVERTISE,
            Manifest.permission.BLUETOOTH_CONNECT,
            Manifest.permission.BLUETOOTH_SCAN
        }),
        @Permission(alias = "wifi", strings = { Manifest.permission.NEARBY_WIFI_DEVICES }),
        @Permission(alias = "notifications", strings = { Manifest.permission.POST_NOTIFICATIONS })
    }
)
public class NearbyConnectionsPlugin extends Plugin {
    private static final String SERVICE_ID = "uk.co.oliverdelange.tiles.nearby";
    private final Map<String, String> endpointNames = new HashMap<>();
    private final Map<String, java.util.function.Consumer<Boolean>> verifications = new HashMap<>();
    private final HashSet<String> outgoingConnections = new HashSet<>();
    private ConnectionsClient client;

    @Override
    public void load() {
        client = Nearby.getConnectionsClient(getContext());
    }

    @PluginMethod
    public void isAvailable(PluginCall call) {
        JSObject result = new JSObject();
        result.put("available", true);
        JSArray permissionAliases = new JSArray();
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
            permissionAliases.put("bluetooth");
            permissionAliases.put("wifi");
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            permissionAliases.put("location");
            permissionAliases.put("bluetooth");
        } else {
            permissionAliases.put("location");
        }
        result.put("permissionAliases", permissionAliases);
        call.resolve(result);
    }

    @PluginMethod
    public void ensurePermissions(PluginCall call) {
        String[] aliases = permissionAliases();
        for (String alias : aliases) {
            if (getPermissionState(alias) != PermissionState.GRANTED) {
                requestPermissionForAliases(aliases, call, "nearbyPermissionsResult");
                return;
            }
        }
        call.resolve();
    }

    @PermissionCallback
    public void nearbyPermissionsResult(PluginCall call) {
        for (String alias : permissionAliases()) {
            if (getPermissionState(alias) != PermissionState.GRANTED) {
                call.reject("Nearby devices permission is required.");
                return;
            }
        }
        call.resolve();
    }

    @PluginMethod
    public void requestNotificationPermission(PluginCall call) {
        if (Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU || getPermissionState("notifications") == PermissionState.GRANTED) {
            call.resolve();
            return;
        }
        requestPermissionForAliases(new String[] { "notifications" }, call, "notificationPermissionResult");
    }

    @PermissionCallback
    public void notificationPermissionResult(PluginCall call) { call.resolve(); }

    private String[] permissionAliases() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) return new String[] { "bluetooth", "wifi" };
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) return new String[] { "location", "bluetooth" };
        return new String[] { "location" };
    }

    @PluginMethod
    public void startAdvertising(PluginCall call) {
        String name = call.getString("name", "Tiles player");
        client.stopAdvertising();
        client.startAdvertising(name, SERVICE_ID, lifecycle,
                new AdvertisingOptions.Builder().setStrategy(Strategy.P2P_STAR).build())
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(error -> call.reject(error.getMessage(), error));
    }

    @PluginMethod
    public void stopAdvertising(PluginCall call) {
        client.stopAdvertising();
        call.resolve();
    }

    @PluginMethod
    public void startDiscovery(PluginCall call) {
        client.stopDiscovery();
        client.startDiscovery(SERVICE_ID, discovery,
                new DiscoveryOptions.Builder().setStrategy(Strategy.P2P_STAR).build())
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(error -> call.reject(error.getMessage(), error));
    }

    @PluginMethod
    public void stopDiscovery(PluginCall call) {
        client.stopDiscovery();
        call.resolve();
    }

    @PluginMethod
    public void setKeepAwake(PluginCall call) {
        boolean enabled = Boolean.TRUE.equals(call.getBoolean("enabled"));
        if (getActivity() == null) { call.resolve(); return; }
        getActivity().runOnUiThread(() -> {
            if (enabled) getActivity().getWindow().addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            else getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON);
            call.resolve();
        });
    }

    @PluginMethod
    public void requestConnection(PluginCall call) {
        String endpointId = call.getString("endpointId");
        String name = call.getString("name", "Tiles player");
        if (endpointId == null) { call.reject("endpointId is required"); return; }
        outgoingConnections.add(endpointId);
        client.requestConnection(name, endpointId, lifecycle)
            .addOnSuccessListener(unused -> call.resolve())
            .addOnFailureListener(error -> {
                outgoingConnections.remove(endpointId);
                call.reject(error.getMessage(), error);
            });
    }

    @PluginMethod
    public void acceptVerification(PluginCall call) {
        String endpointId = call.getString("endpointId");
        boolean accept = Boolean.TRUE.equals(call.getBoolean("accept"));
        if (endpointId == null || !verifications.containsKey(endpointId)) { call.reject("No pending verification"); return; }
        ((NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE)).cancel(endpointId.hashCode());
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
        if (getActivity() != null) getActivity().runOnUiThread(() ->
            getActivity().getWindow().clearFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON));
        call.resolve();
    }

    private JSObject endpoint(String id) {
        JSObject value = new JSObject();
        value.put("endpointId", id);
        value.put("name", endpointNames.getOrDefault(id, "Nearby player"));
        return value;
    }

    private void showInviteNotification(String id, String name) {
        NotificationManager notifications = (NotificationManager) getContext().getSystemService(Context.NOTIFICATION_SERVICE);
        String channelId = "tiles_game_invites";
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            notifications.createNotificationChannel(new NotificationChannel(channelId, "Game invitations", NotificationManager.IMPORTANCE_HIGH));
        }
        Intent launch = getContext().getPackageManager().getLaunchIntentForPackage(getContext().getPackageName());
        PendingIntent pending = PendingIntent.getActivity(getContext(), id.hashCode(), launch, PendingIntent.FLAG_UPDATE_CURRENT | PendingIntent.FLAG_IMMUTABLE);
        android.app.Notification.Builder builder = Build.VERSION.SDK_INT >= Build.VERSION_CODES.O
            ? new android.app.Notification.Builder(getContext(), channelId)
            : new android.app.Notification.Builder(getContext());
        builder.setSmallIcon(R.mipmap.ic_launcher)
            .setContentTitle("Tiles game invitation")
            .setContentText(name + " invited you to play")
            .setContentIntent(pending)
            .setAutoCancel(true);
        notifications.notify(id.hashCode(), builder.build());
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
            if (!outgoingConnections.contains(id)) showInviteNotification(id, info.getEndpointName());
            JSObject value = endpoint(id);
            String code = info.getAuthenticationToken();
            value.put("code", code == null || code.isEmpty() ? info.getAuthenticationDigits() : code);
            verifications.put(id, accept -> {
                if (accept) client.acceptConnection(id, payloads);
                else client.rejectConnection(id);
            });
            notifyListeners("verificationRequired", value);
        }
        @Override public void onConnectionResult(String id, ConnectionResolution resolution) {
            outgoingConnections.remove(id);
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
