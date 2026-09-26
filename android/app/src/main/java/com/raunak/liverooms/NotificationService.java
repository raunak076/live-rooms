package com.raunak.liverooms;

import android.app.*;
import android.content.*;
import android.graphics.Color;
import android.os.*;
import androidx.core.app.NotificationCompat;
import androidx.core.app.Person;
import androidx.core.app.RemoteInput;
import org.json.JSONObject;
import java.net.URI;
import java.util.UUID;
import io.socket.client.IO;
import io.socket.client.Socket;

public class NotificationService extends Service {
    public static final String PREFS="live_rooms_native", EXTRA_TOKEN="token", EXTRA_USERNAME="username", EXTRA_ROOM_ID="room_id", EXTRA_CALL_ID="call_id";
    public static final String ACTION_REPLY="com.raunak.liverooms.REPLY", ACTION_CLEAR="com.raunak.liverooms.CLEAR", ACTION_DECLINE="com.raunak.liverooms.DECLINE", EXTRA_REPLY="reply_text", EXTRA_NOTIFICATION_ID="notification_id";
    private static final String APP_URL="https://live-rooms-production.up.railway.app", SERVICE_CHANNEL="live_connection", MESSAGE_CHANNEL="live_messages_v2", CALL_CHANNEL="live_calls_v2";
    private static final int SERVICE_NOTIFICATION=73;
    private Socket socket; private String username="", token="", pendingRoom="", pendingText="", pendingDeclineRoom="", pendingDeclineCall=""; private boolean authenticated;

    @Override public void onCreate(){super.onCreate();createChannels();}
    @Override public int onStartCommand(Intent intent,int flags,int startId){
        SharedPreferences prefs=getSharedPreferences(PREFS,MODE_PRIVATE);
        if(intent!=null){
            String nextToken=intent.getStringExtra(EXTRA_TOKEN),user=intent.getStringExtra(EXTRA_USERNAME);
            if(nextToken!=null&&nextToken.matches("[a-f0-9]{64}")&&user!=null&&user.matches("[a-z0-9_]{3,24}"))prefs.edit().putString(EXTRA_TOKEN,nextToken).putString(EXTRA_USERNAME,user).apply();
            if(ACTION_REPLY.equals(intent.getAction())){pendingRoom=intent.getStringExtra(EXTRA_ROOM_ID);pendingText=intent.getStringExtra(EXTRA_REPLY);}
            if(ACTION_DECLINE.equals(intent.getAction())){pendingDeclineRoom=intent.getStringExtra(EXTRA_ROOM_ID);pendingDeclineCall=intent.getStringExtra(EXTRA_CALL_ID);}
        }
        token=prefs.getString(EXTRA_TOKEN,"");username=prefs.getString(EXTRA_USERNAME,"");startForeground(SERVICE_NOTIFICATION,serviceNotification("Connected for messages & calls"));
        if(token.matches("[a-f0-9]{64}")&&username.matches("[a-z0-9_]{3,24}")){if(socket==null||!socket.connected())connect();else sendPendingActions();}else stopSelf();return START_STICKY;
    }
    private void connect(){
        if(socket!=null){socket.off();socket.disconnect();}authenticated=false;
        try{
            IO.Options options=IO.Options.builder().setReconnection(true).setReconnectionAttempts(Integer.MAX_VALUE).setReconnectionDelay(700).setReconnectionDelayMax(8000).build();
            socket=IO.socket(URI.create(APP_URL),options);
            socket.on(Socket.EVENT_CONNECT,args->{try{socket.emit("auth",new JSONObject().put("token",token),(io.socket.client.Ack)response->{if(response.length>0&&response[0] instanceof JSONObject&&((JSONObject)response[0]).has("error"))stopSelf();else{authenticated=true;updateServiceNotification("Messages & calls ready");sendPendingActions();}});}catch(Exception ignored){}});
            socket.on("message",args->{if(args.length>0&&args[0] instanceof JSONObject)showMessage((JSONObject)args[0]);});
            socket.on("call:ring",args->{if(args.length>0&&args[0] instanceof JSONObject)showCall((JSONObject)args[0]);});
            socket.on("call:ended",args->{if(args.length>0&&args[0] instanceof JSONObject)cancelCall((JSONObject)args[0]);});
            socket.on("call:declined",args->{if(args.length>0&&args[0] instanceof JSONObject)cancelCall((JSONObject)args[0]);});
            socket.connect();
        }catch(Exception ignored){updateServiceNotification("Waiting for network…");}
    }
    private void sendPendingActions(){
        if(!authenticated||socket==null||!socket.connected())return;
        if(pendingRoom!=null&&pendingText!=null&&pendingRoom.matches("[a-f0-9]{24}")&&!pendingText.trim().isEmpty())try{socket.emit("send",new JSONObject().put("roomId",pendingRoom).put("text",pendingText.trim()).put("clientId",UUID.randomUUID().toString()),(io.socket.client.Ack)response->{});pendingRoom="";pendingText="";}catch(Exception ignored){}
        if(pendingDeclineRoom!=null&&pendingDeclineCall!=null&&pendingDeclineRoom.matches("[a-f0-9]{24}")&&pendingDeclineCall.matches("[a-f0-9-]{20,64}"))try{socket.emit("call:decline",new JSONObject().put("roomId",pendingDeclineRoom).put("callId",pendingDeclineCall),(io.socket.client.Ack)response->{});pendingDeclineRoom="";pendingDeclineCall="";}catch(Exception ignored){}
    }
    private void showMessage(JSONObject data){
        if(username.equals(data.optString("senderId")))return;
        String roomId=data.optString("roomId");if(!roomId.matches("[a-f0-9]{24}"))return;
        String title=data.optString("name","New message"),text=data.has("attachment")?(data.optJSONObject("attachment")!=null&&"audio".equals(data.optJSONObject("attachment").optString("type"))?"🎤 Voice message":"📎 Sent an attachment"):data.optString("text","New message");
        int notificationId=data.optString("id",roomId).hashCode();
        RemoteInput remoteInput=new RemoteInput.Builder(EXTRA_REPLY).setLabel("Type a reply…").build();
        PendingIntent replyIntent=broadcastIntent(ACTION_REPLY,roomId,"",notificationId,notificationId+1);
        NotificationCompat.Action replyAction=new NotificationCompat.Action.Builder(0,"Reply",replyIntent).addRemoteInput(remoteInput).setAllowGeneratedReplies(true).build();
        PendingIntent clearIntent=broadcastIntent(ACTION_CLEAR,roomId,"",notificationId,notificationId+2);
        Person sender=new Person.Builder().setName(title).build();
        NotificationCompat.MessagingStyle style=new NotificationCompat.MessagingStyle(new Person.Builder().setName(username.isEmpty()?"You":username).build()).addMessage(text,System.currentTimeMillis(),sender);
        Notification n=new NotificationCompat.Builder(this,MESSAGE_CHANNEL)
                .setSmallIcon(R.drawable.ic_launcher).setContentTitle(title).setContentText(text).setStyle(style)
                .setCategory(NotificationCompat.CATEGORY_MESSAGE).setVisibility(NotificationCompat.VISIBILITY_PRIVATE)
                .setAutoCancel(true).setPriority(NotificationCompat.PRIORITY_HIGH).setDefaults(NotificationCompat.DEFAULT_ALL)
                .setContentIntent(openIntent(roomId,"",notificationId)).setGroup("chat-"+roomId)
                .addAction(replyAction).addAction(0,"Clear",clearIntent).build();
        getSystemService(NotificationManager.class).notify(notificationId,n);
    }
    private void showCall(JSONObject data){
        String roomId=data.optString("roomId"),callId=data.optString("callId"),caller=data.optString("by","Someone");if(!roomId.matches("[a-f0-9]{24}")||!callId.matches("[a-f0-9-]{20,64}"))return;
        int id=callId.hashCode();
        PendingIntent open=openIntent(roomId,callId,id);
        PendingIntent answer=openIntent(roomId,callId,id+11);
        PendingIntent decline=broadcastIntent(ACTION_DECLINE,roomId,callId,id,id+12);
        Notification n=new NotificationCompat.Builder(this,CALL_CHANNEL)
                .setSmallIcon(R.drawable.ic_launcher).setContentTitle(caller).setContentText("Incoming Live Rooms voice call")
                .setCategory(NotificationCompat.CATEGORY_CALL).setVisibility(NotificationCompat.VISIBILITY_PUBLIC)
                .setPriority(NotificationCompat.PRIORITY_MAX).setOngoing(true).setAutoCancel(false)
                .setDefaults(NotificationCompat.DEFAULT_ALL).setVibrate(new long[]{0,700,250,700,250,900})
                .setFullScreenIntent(open,true).setContentIntent(open)
                .addAction(0,"Decline",decline).addAction(0,"Answer",answer).build();
        getSystemService(NotificationManager.class).notify(id,n);
    }
    private void cancelCall(JSONObject data){String callId=data.optString("callId");if(!callId.isEmpty())getSystemService(NotificationManager.class).cancel(callId.hashCode());}
    private PendingIntent openIntent(String roomId,String callId,int code){Intent i=new Intent(this,MainActivity.class).addFlags(Intent.FLAG_ACTIVITY_SINGLE_TOP|Intent.FLAG_ACTIVITY_CLEAR_TOP).putExtra(EXTRA_ROOM_ID,roomId).putExtra(EXTRA_CALL_ID,callId);return PendingIntent.getActivity(this,code,i,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_IMMUTABLE);}
    private PendingIntent broadcastIntent(String action,String roomId,String callId,int notificationId,int code){Intent i=new Intent(this,NotificationActionReceiver.class).setAction(action).putExtra(EXTRA_ROOM_ID,roomId).putExtra(EXTRA_CALL_ID,callId).putExtra(EXTRA_NOTIFICATION_ID,notificationId);return PendingIntent.getBroadcast(this,code,i,PendingIntent.FLAG_UPDATE_CURRENT|PendingIntent.FLAG_MUTABLE);}
    private Notification serviceNotification(String text){return new NotificationCompat.Builder(this,SERVICE_CHANNEL).setSmallIcon(R.drawable.ic_launcher).setContentTitle("Live Rooms").setContentText(text).setOngoing(true).setSilent(true).setOnlyAlertOnce(true).setContentIntent(openIntent("","",SERVICE_NOTIFICATION)).build();}
    private void updateServiceNotification(String text){getSystemService(NotificationManager.class).notify(SERVICE_NOTIFICATION,serviceNotification(text));}
    private void createChannels(){
        if(Build.VERSION.SDK_INT<Build.VERSION_CODES.O)return;NotificationManager m=getSystemService(NotificationManager.class);
        NotificationChannel service=new NotificationChannel(SERVICE_CHANNEL,"Live connection",NotificationManager.IMPORTANCE_LOW);service.setDescription("Keeps Live Rooms ready for messages and calls");service.setSound(null,null);m.createNotificationChannel(service);
        NotificationChannel messages=new NotificationChannel(MESSAGE_CHANNEL,"Chat messages",NotificationManager.IMPORTANCE_HIGH);messages.setDescription("Message alerts with quick reply");messages.enableVibration(true);messages.enableLights(true);messages.setLightColor(Color.GREEN);m.createNotificationChannel(messages);
        NotificationChannel calls=new NotificationChannel(CALL_CHANNEL,"Incoming calls",NotificationManager.IMPORTANCE_HIGH);calls.setDescription("Incoming Live Rooms calls");calls.enableVibration(true);calls.setVibrationPattern(new long[]{0,700,250,700,250,900});calls.setLightColor(Color.GREEN);calls.enableLights(true);m.createNotificationChannel(calls);
    }
    @Override public void onDestroy(){if(socket!=null){socket.off();socket.disconnect();socket=null;}super.onDestroy();}
    @Override public IBinder onBind(Intent intent){return null;}
}
