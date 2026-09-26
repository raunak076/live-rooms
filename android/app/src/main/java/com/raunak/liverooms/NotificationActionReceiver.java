package com.raunak.liverooms;

import android.app.NotificationManager;
import android.content.*;
import android.os.Build;
import android.os.Bundle;
import androidx.core.app.RemoteInput;

public class NotificationActionReceiver extends BroadcastReceiver {
    @Override public void onReceive(Context context,Intent intent){
        int notificationId=intent.getIntExtra(NotificationService.EXTRA_NOTIFICATION_ID,0);
        context.getSystemService(NotificationManager.class).cancel(notificationId);
        String action=intent.getAction(),roomId=intent.getStringExtra(NotificationService.EXTRA_ROOM_ID),callId=intent.getStringExtra(NotificationService.EXTRA_CALL_ID);
        if(NotificationService.ACTION_REPLY.equals(action)){
            Bundle input=RemoteInput.getResultsFromIntent(intent);CharSequence reply=input==null?null:input.getCharSequence(NotificationService.EXTRA_REPLY);
            if(reply==null||reply.toString().trim().isEmpty()||roomId==null)return;
            startService(context,new Intent(context,NotificationService.class).setAction(NotificationService.ACTION_REPLY).putExtra(NotificationService.EXTRA_ROOM_ID,roomId).putExtra(NotificationService.EXTRA_REPLY,reply.toString()));
            return;
        }
        if(NotificationService.ACTION_DECLINE.equals(action)&&roomId!=null&&callId!=null){
            startService(context,new Intent(context,NotificationService.class).setAction(NotificationService.ACTION_DECLINE).putExtra(NotificationService.EXTRA_ROOM_ID,roomId).putExtra(NotificationService.EXTRA_CALL_ID,callId));
        }
    }
    private void startService(Context context,Intent service){if(Build.VERSION.SDK_INT>=Build.VERSION_CODES.O)context.startForegroundService(service);else context.startService(service);}
}
