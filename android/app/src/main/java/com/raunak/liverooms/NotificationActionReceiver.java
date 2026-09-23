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
        if(!NotificationService.ACTION_REPLY.equals(intent.getAction()))return;
        Bundle input=RemoteInput.getResultsFromIntent(intent);CharSequence reply=input==null?null:input.getCharSequence(NotificationService.EXTRA_REPLY);String roomId=intent.getStringExtra(NotificationService.EXTRA_ROOM_ID);
        if(reply==null||reply.toString().trim().isEmpty()||roomId==null)return;
        Intent service=new Intent(context,NotificationService.class).setAction(NotificationService.ACTION_REPLY).putExtra(NotificationService.EXTRA_ROOM_ID,roomId).putExtra(NotificationService.EXTRA_REPLY,reply.toString());
        if(Build.VERSION.SDK_INT>=Build.VERSION_CODES.O)context.startForegroundService(service);else context.startService(service);
    }
}
