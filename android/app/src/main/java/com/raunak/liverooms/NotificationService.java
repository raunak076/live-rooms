package com.raunak.liverooms;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.os.*;
import androidx.core.app.NotificationCompat;
import androidx.core.app.RemoteInput;
import org.json.JSONObject;
import java.net.URI;
import java.util.UUID;
import io.socket.client.IO;
import io.socket.client.Socket;

public class NotificationService extends Service {
    public static final String PREFS="live_rooms_native", EXTRA_TOKEN="token", EXTRA_USERNAME="username", EXTRA_ROOM_ID="room_id", EXTRA_CALL_ID="call_id";
    public static final String ACTION_REPLY="com.raunak.liverooms.REPLY", ACTION_CLEAR="com.raunak.liverooms.CLEAR", EXTRA_REPLY="reply_text", EXTRA_NOTIFICATION_ID="notification_id";
    private static final String APP_URL="https://live-rooms-production.up.railway.app", SERVICE_CHANNEL="live_connection", MESSAGE_CHANNEL="live_messages", CALL_CHANNEL="live_calls";
    private static final int SERVICE_NOTIFICATION=73;
    private Socket socket; private String username="", token="", pendingRoom="", pendingText=""; private boolean authenticated;

    @Override public void onCreate(){super.onCreate();createChannels();}
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        SharedPreferences prefs=getSharedPreferences(PREFS,MODE_PRIVATE);
        if(intent!=null){String nextToken=intent.getStringExtra(EXTRA_TOKEN),user=intent.getStringExtra(EXTRA_USERNAME);if(nextToken!=null&&nextToken.matches("[a-f0-9]{64}")&&user!=null&&user.matches("[a-z0-9_]{3,24}"))prefs.edit().putString(EXTRA_TOKEN,nextToken).putString(EXTRA_USERNAME,user).apply();if(ACTION_REPLY.equals(intent.getAction())){pendingRoom=intent.getStringExtra(EXTRA_ROOM_ID);pendingText=intent.getStringExtra(EXTRA_REPLY);}}
        token=prefs.getString(EXTRA_TOKEN,"");username=prefs.getString(EXTRA_USERNAME,"");startForeground(SERVICE_NOTIFICATION,serviceNotification("Connecting…"));
        if(token.matches("[a-f0-9]{64}")&&username.matches("[a-z0-9_]{3,24}")){if(socket==null||!socket.connected())connect();else sendPendingReply();}else stopSelf();return START_STICKY;
    }
    private void connect(){if(socket!=null){socket.off();socket.disconnect();}authenticated=false;try{IO.Options options=IO.Options.builder().setReconnection(true).setReconnectionAttempts(Integer.MAX_VALUE).setReconnectionDelay(700).setReconnectionDelayMax(8000).build();socket=IO.socket(URI.create(APP_URL),options);socket.on(Socket.EVENT_CONNECT,args->{try{socket.emit("auth",new JSONObject().put("token",token),(io.socket.client.Ack)response->{if(response.length>0&&response[0] instanceof JSONObject&&((JSONObject)response[0]).has("error"))stopSelf();else{authenticated=true;updateServiceNotification("Notifications ready");sendPendingReply();}});}catch(Exception ignored){}});socket.on("message",args->{if(args.length>0&&args[0] instanceof JSONObject)showMessage((JSONObject)args[0]);});socket.on("call:ring",args->{if(args.length>0&&args[0] instanceof JSONObject)showCall((JSONObject)args[0]);});socket.on("call:ended",args->{if(args.length>0&&args[0] instanceof JSONObject)cancelCall((JSONObject)args[0]);});socket.connect();}catch(Exception ignored){updateServiceNotification("Waiting for network…");}}
    private void sendPendingReply(){if(!authenticated||socket==null||!socket.connected()||pendingRoom==null||pendingText==null||!pendingRoom.matches("[a-f0-9]{24}")||pendingText.trim().isEmpty())return;try{socket.emit("send",new JSONObject().put("roomId",pendingRoom).put("text",pendingText.trim()).put("clientId",UUID.randomUUID().toString()),(io.socket.client.Ack)response->{});pendingRoom="";pendingText="";}catch(Exception ignored){}}
    private boolean appIsForeground(){return getSharedPreferences(PREFS,MODE_PRIVATE).getBoolean("app_foreground",false);}
    private void showMessage(JSONObject data){if(appIsForeground()||username.equals(data.optString("senderId")))return;String roomId=data.optString("roomId");if(!roomId.matches("[a-f0-9]{24}"))return;String title=data.optString("name","New message"),text=data.has("attachment")?"Sent an attachment":data.optString("text","New message");int notificationId=data.optString("id",roomId).hashCode();RemoteInput remoteInput=new RemoteInput.Builder(EXTRA_REPLY).setLabel("Reply").build();PendingIntent replyIntent=broadcastIntent(ACTION_REPLY,roomId,notificationId,notificationId+1);NotificationCompat.Action replyAction=new NotificationCompat.Action.Builder(0,"Reply",replyIntent).addRemoteInput(remoteInput).setAllowGeneratedReplies(true).build();PendingIntent clearIntent=broadcastIntent(ACTION_CLEAR,roomId,notificationId,notificationId+2);Notification n=new NotificationCompat.Builder(this,MESSAGE_CHANNEL).setSmallIcon(R.drawable.ic_launcher).setContentTitle(title).setContentText(text).setStyle(new NotificationCompat.BigTextStyle().bigText(text)).setAutoCancel(true).setPriority(NotificationCompat.PRIORITY_HIGH).setContentIntent(openIntent(roomId,"",notificationId)).addAction(replyAction).addAction(0,"Clear",clearIntent).build();getSystemService(NotificationManager.class).notify(notificationId,n);}
    private void showCall(JSONObject data){if(appIsForeground())return;String roomId=data.optString("roomId"),callId=data.optString("callId"),caller=data.optString("by","Someone");if(!roomId.matches("[a-f0-9]{24}"))return;PendingIntent open=openIntent(roomId,callId,callId.hashCode());Notification n=new NotificationCompat.Builder(this,CALL_CHANNEL).setSmallIcon(R.drawable.ic_launcher).setContentTitle("Incoming Live Chat call").setContentText(caller+" is calling").setCategory(NotificationCompat.CATEGORY_CALL).setPriority(NotificationCompat.PRIORITY_MAX).setOngoing(true).setVibrate(new long[]{0,700,250,700,250,900}).setFullScreenIntent(open,true).setContentIntent(open).build();getSystemService(NotificationManager.class).notify(callId.hashCode(),n);}
    private void cancelCall(JSONObject data){String callId=data.optString("callId");if(!callId.isEmpty())getSystemService(NotificationManager.class).cancel(callId.hashCode());}
    private PendingIntent openIntent(String roomId,String callId,int code){Intent i=new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP).putExtra(EXTRA_ROOM_ID,roomId).putExtra(EXTRA_CALL_ID,callId);return PendingIntent.getActivity(this,code,i,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);}
    private PendingIntent broadcastIntent(String action,String roomId,int notificationId,int code){Intent i=new Intent(this,NotificationActionReceiver.class).setAction(action).putExtra(EXTRA_ROOM_ID,roomId).putExtra(EXTRA_NOTIFICATION_ID,notificationId);return PendingIntent.getBroadcast(this,code,i,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_MUTABLE);}
    private Notification serviceNotification(String text){return new NotificationCompat.Builder(this,SERVICE_CHANNEL).setSmallIcon(R.drawable.ic_launcher).setContentTitle("Live Chat").setContentText(text).setOngoing(true).setSilent(true).setContentIntent(openIntent("","",SERVICE_NOTIFICATION)).build();}
    private void updateServiceNotification(String text){getSystemService(NotificationManager.class).notify(SERVICE_NOTIFICATION,serviceNotification(text));}
    private void createChannels(){if(Build.VERSION.SDK_INT<Build.VERSION_CODES.O)return;NotificationManager m=getSystemService(NotificationManager.class);NotificationChannel service=new NotificationChannel(SERVICE_CHANNEL,"Live connection",NotificationManager.IMPORTANCE_LOW);service.setSound(null,null);m.createNotificationChannel(service);NotificationChannel messages=new NotificationChannel(MESSAGE_CHANNEL,"Messages",NotificationManager.IMPORTANCE_HIGH);messages.enableVibration(true);m.createNotificationChannel(messages);NotificationChannel calls=new NotificationChannel(CALL_CHANNEL,"Calls",NotificationManager.IMPORTANCE_HIGH);calls.enableVibration(true);calls.setVibrationPattern(new long[]{0,700,250,700,250,900});calls.setLightColor(Color.GREEN);calls.enableLights(true);m.createNotificationChannel(calls);}
    @Override public void onDestroy(){if(socket!=null){socket.off();socket.disconnect();socket=null;}super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
}
